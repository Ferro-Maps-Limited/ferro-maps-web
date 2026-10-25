import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { auth, db } from './firebase'

/**
 * How long the dashboard waits for onAccountDeletionRequest.
 *
 * Sibling request handlers in this repo (tickets, account actions, config)
 * use 15s. Account deletion can walk every subcollection before it writes
 * the result, and the handler itself is not in this repo, so the wait is
 * longer. The figure is a client timeout, not a server deadline.
 */
export const ACCOUNT_DELETION_TIMEOUT_MS = 60_000

const NOTICE_KEY = 'ferro.accountDeleted'

let accountDeleted = false
const noticeListeners = new Set<() => void>()

export class AccountDeletionCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'AccountDeletionCancelled'
  }
}

export function markAccountDeleted(): void {
  sessionStorage.setItem(NOTICE_KEY, '1')
  accountDeleted = true
  noticeListeners.forEach((listener) => listener())
}

export function accountDeletedNoticeVisible(): boolean {
  return accountDeleted || sessionStorage.getItem(NOTICE_KEY) === '1'
}

export function dismissAccountDeletedNotice(): void {
  accountDeleted = false
  sessionStorage.removeItem(NOTICE_KEY)
}

export function subscribeAccountDeleted(listener: () => void): () => void {
  noticeListeners.add(listener)
  return () => noticeListeners.delete(listener)
}

function firebaseCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    return typeof code === 'string' ? code : ''
  }
  return ''
}

function messageFrom(data: Record<string, unknown> | undefined, fallback: string): string {
  const error = data?.error
  return typeof error === 'string' && error.trim() ? error : fallback
}

function readableFirestoreError(err: unknown): string {
  const code = firebaseCode(err)
  if (code === 'permission-denied') {
    return 'Firestore refused the deletion request. If you already asked to delete this account, contact support.'
  }
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return 'You appear to be offline. Check your connection and try again.'
  }
  if (err instanceof Error && err.message && err.message !== 'cancelled') return err.message
  return 'An error occurred. Please try again.'
}

/**
 * The Auth user object captured when the request started.
 * reload() throws auth/user-not-found only after the server has deleted it.
 * A voluntary sign-out fails with a different code, so the two are not confused.
 */
async function authUserWasDeleted(user: User): Promise<boolean> {
  try {
    await user.reload()
    return false
  } catch (err) {
    return firebaseCode(err) === 'auth/user-not-found'
  }
}

/**
 * Create accountDeletionRequests/{uid} and wait until the server finishes.
 *
 * onAccountDeletionRequest is deployed from the iOS repo and is not in this
 * codebase. The contract this file can actually see is:
 *
 * - firestore.rules let the owner create the doc with exactly
 *   { status: 'pending', createdAt }. Updates and deletes are denied, and
 *   the comment names `done` as the status a client must not be able to forge.
 * - Every other request trigger in this repo (onAccountAction, onTicketRequest,
 *   onConfigRequest) writes status "done", or status "error" plus an `error`
 *   string. A non-pending, non-done status is treated as failure and the
 *   `error` string is shown when it is present.
 * - Rules allow the owner to read the request and nobody else. Once the
 *   handler deletes the Auth user, this client can no longer see a later
 *   status write. reload() returning auth/user-not-found is therefore also
 *   completion. This client never calls deleteUser().
 *
 * `cancel` rejects with AccountDeletionCancelled and stops listening. It does
 * not delete the request document (rules would refuse that anyway).
 */
export function requestAccountDeletion(uid: string): {
  promise: Promise<void>
  cancel: () => void
} {
  let unsubscribeDoc = () => {}
  let unsubscribeAuth = () => {}
  let timer = 0
  let settled = false
  let rejectPending: ((err: Error) => void) | null = null
  const startedAs = auth.currentUser

  const stop = () => {
    window.clearTimeout(timer)
    unsubscribeDoc()
    unsubscribeAuth()
  }

  const cancel = () => {
    if (settled) return
    settled = true
    stop()
    rejectPending?.(new AccountDeletionCancelled())
  }

  const promise = new Promise<void>((resolve, reject) => {
    rejectPending = reject
    const ref = doc(db, 'accountDeletionRequests', uid)

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      stop()
      fn()
    }

    const fail = (message: string) => settle(() => reject(new Error(message)))
    const succeed = () => settle(() => {
      // The dashboard often unmounts in the same turn the Auth user disappears,
      // which is before the caller can record anything. Mark it here.
      markAccountDeleted()
      resolve()
    })

    const watch = () => {
      timer = window.setTimeout(() => {
        fail(
          'Your deletion request was submitted, but it is still processing. Stay signed in and try again in a few minutes, or contact support if this continues.',
        )
      }, ACCOUNT_DELETION_TIMEOUT_MS)

      unsubscribeDoc = onSnapshot(
        ref,
        (snap) => {
          const data = snap.data()
          if (!data || data.status === 'pending') return
          if (data.status === 'done') {
            succeed()
            return
          }
          fail(messageFrom(data, 'Account deletion failed. Please try again or contact support.'))
        },
        () => {
          const user = startedAs && startedAs.uid === uid ? startedAs : auth.currentUser
          if (!user || user.uid !== uid) {
            succeed()
            return
          }
          void authUserWasDeleted(user).then((deleted) => {
            if (deleted) succeed()
            else fail('Lost contact with the deletion request before it finished. Please try again.')
          })
        },
      )

      unsubscribeAuth = onAuthStateChanged(auth, (user) => {
        if (user?.uid === uid) return
        const captured = startedAs && startedAs.uid === uid ? startedAs : null
        if (!captured) {
          if (!user) succeed()
          return
        }
        void authUserWasDeleted(captured).then((deleted) => {
          if (deleted) succeed()
        })
      })
    }

    const followExisting = (data: Record<string, unknown>) => {
      if (data.status === 'done') {
        succeed()
        return
      }
      if (data.status !== 'pending') {
        fail(
          messageFrom(
            data,
            'A previous deletion request failed, and Firestore does not allow sending another from the app. Please contact support.',
          ),
        )
        return
      }
      watch()
    }

    getDoc(ref)
      .then(async (snap) => {
        if (settled) return
        if (snap.exists()) {
          followExisting(snap.data())
          return
        }
        try {
          await setDoc(ref, {
            status: 'pending',
            createdAt: serverTimestamp(),
          })
        } catch (err) {
          if (settled) return
          if (firebaseCode(err) === 'permission-denied') {
            const again = await getDoc(ref)
            if (again.exists()) {
              followExisting(again.data())
              return
            }
          }
          fail(readableFirestoreError(err))
          return
        }
        if (!settled) watch()
      })
      .catch((err) => {
        if (!settled) fail(readableFirestoreError(err))
      })
  })

  return { promise, cancel }
}
