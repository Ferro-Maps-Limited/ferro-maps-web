import { useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import {
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
} from 'firebase/firestore'
import { auth, db } from './firebase'

/**
 * Confirmed onAccountDeletionRequest contract (Ferro iOS):
 *
 * - Create once: { status: 'pending', createdAt: serverTimestamp() }.
 *   serverTimestamp() is what the rules compare to request.time.
 * - status 'done' (server also writes completedAt): success. Sign out.
 * - status 'error': the `error` string is user-facing. Show it verbatim.
 *   Never display `errorCode`. Retry updates the same doc back to pending
 *   and deletes `error`, `errorCode`, and `completedAt`. Never create or
 *   delete the doc again.
 * - After a submit, auth/user-not-found, auth/user-token-expired, and
 *   permission-denied mean the Auth user is probably already gone.
 * - The 60s wait is not a failure. Keep listening and allow a re-read.
 */
export const ACCOUNT_DELETION_TIMEOUT_MS = 60_000

const NOTICE_KEY = 'ferro.accountDeleted'

let accountDeleted = false
const noticeListeners = new Set<() => void>()

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

export type DeletionDocStatus = 'missing' | 'pending' | 'done' | 'error' | 'unknown'

export interface DeletionSnapshot {
  status: DeletionDocStatus
  /** Present only when status is 'error'. Shown verbatim. */
  error?: string
}

export type DeletionPhase = 'confirm' | 'pending' | 'still-processing' | 'error' | 'success'

export interface DeletionState {
  phase: DeletionPhase
  error: string
  /** True when `error` is the handler's own user-facing string, so Retry is valid. */
  serverError: boolean
}

export type DeletionEvent =
  | { type: 'doc'; snapshot: DeletionSnapshot }
  | { type: 'create-started' }
  | { type: 'retry-started' }
  | { type: 'timeout' }
  | { type: 'likely-done' }

export const INITIAL_DELETION_STATE: DeletionState = { phase: 'confirm', error: '', serverError: false }

const LIKELY_DONE_AUTH_CODES = new Set(['auth/user-not-found', 'auth/user-token-expired'])

export function firebaseCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    return typeof code === 'string' ? code : ''
  }
  return ''
}

export function isLikelyDoneAuthCode(code: string): boolean {
  return LIKELY_DONE_AUTH_CODES.has(code)
}

export function isPermissionDenied(code: string): boolean {
  return code === 'permission-denied'
}

export function interpretDeletionDoc(exists: boolean, data: DocumentData | undefined): DeletionSnapshot {
  if (!exists || !data) return { status: 'missing' }
  if (data.status === 'done') return { status: 'done' }
  if (data.status === 'error') {
    return { status: 'error', error: typeof data.error === 'string' ? data.error : '' }
  }
  if (data.status === 'pending') return { status: 'pending' }
  return { status: 'unknown' }
}

/**
 * Pure transitions for the deletion dialog.
 * A pending snapshot does not leave 'still-processing': the timeout is not a failure.
 * 'missing' does not undo a request already in flight.
 */
export function reduceDeletion(state: DeletionState, event: DeletionEvent): DeletionState {
  switch (event.type) {
    case 'likely-done':
      return { phase: 'success', error: '', serverError: false }
    case 'timeout':
      return state.phase === 'pending'
        ? { phase: 'still-processing', error: '', serverError: false }
        : state
    case 'create-started':
    case 'retry-started':
      return { phase: 'pending', error: '', serverError: false }
    case 'doc':
      return reduceDoc(state, event.snapshot)
    default:
      return state
  }
}

function reduceDoc(state: DeletionState, snapshot: DeletionSnapshot): DeletionState {
  if (state.phase === 'success') return state
  if (snapshot.status === 'done') return { phase: 'success', error: '', serverError: false }
  if (snapshot.status === 'error') {
    return { phase: 'error', error: snapshot.error ?? '', serverError: true }
  }
  if (snapshot.status === 'unknown') {
    return { phase: 'still-processing', error: '', serverError: false }
  }
  if (snapshot.status === 'pending') {
    if (state.phase === 'still-processing') return state
    return { phase: 'pending', error: '', serverError: false }
  }
  if (state.phase === 'pending' || state.phase === 'still-processing') return state
  return { phase: 'confirm', error: '', serverError: false }
}

function requestRef(uid: string) {
  return doc(db, 'accountDeletionRequests', uid)
}

export async function fetchAccountDeletion(uid: string): Promise<DeletionSnapshot> {
  const snap = await getDoc(requestRef(uid))
  return interpretDeletionDoc(snap.exists(), snap.data())
}

/** First request only. A second create is an update, which the rules deny. */
export async function createAccountDeletionRequest(uid: string): Promise<void> {
  await setDoc(requestRef(uid), {
    status: 'pending',
    createdAt: serverTimestamp(),
  })
}

/** Ask the handler to try again. Does not create or delete the document. */
export async function retryAccountDeletionRequest(uid: string): Promise<void> {
  await updateDoc(requestRef(uid), {
    status: 'pending',
    error: deleteField(),
    errorCode: deleteField(),
    completedAt: deleteField(),
  })
}

function subscribeRequest(
  uid: string,
  onDoc: (snapshot: DeletionSnapshot) => void,
  onError: (code: string) => void,
): () => void {
  return onSnapshot(
    requestRef(uid),
    (snap) => onDoc(interpretDeletionDoc(snap.exists(), snap.data())),
    (err) => onError(firebaseCode(err)),
  )
}

export function useAccountDeletion(uid: string | undefined, onLeave: () => void) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<DeletionState>(INITIAL_DELETION_STATE)
  const stateRef = useRef(state)
  const uidRef = useRef(uid)
  const onLeaveRef = useRef(onLeave)
  const unsubDoc = useRef<(() => void) | null>(null)
  const unsubAuth = useRef<(() => void) | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const signOutTimer = useRef<number | null>(null)
  const awaiting = useRef(false)
  const finished = useRef(false)
  const writing = useRef(false)
  const watchGen = useRef(0)

  useEffect(() => {
    uidRef.current = uid
    onLeaveRef.current = onLeave
  }, [uid, onLeave])

  function commit(next: DeletionState) {
    stateRef.current = next
    setState(next)
  }

  function stopWatch() {
    unsubDoc.current?.()
    unsubDoc.current = null
    unsubAuth.current?.()
    unsubAuth.current = null
  }

  function clearWaitTimer() {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  function stopListening() {
    awaiting.current = false
    stopWatch()
    clearWaitTimer()
  }

  function completeSignOut() {
    if (finished.current) return
    finished.current = true
    stopListening()
    markAccountDeleted()
    commit({ phase: 'success', error: '', serverError: false })
    setOpen(true)
    signOutTimer.current = window.setTimeout(() => {
      signOutTimer.current = null
      onLeaveRef.current()
      void signOut(auth).catch(() => {
        // The handler may already have deleted the Auth user.
      })
    }, 1200)
  }

  function apply(event: DeletionEvent) {
    if (finished.current) return
    const next = reduceDeletion(stateRef.current, event)
    if (next.phase === 'success') {
      completeSignOut()
      return
    }
    commit(next)
    if (next.phase === 'error') {
      awaiting.current = false
      clearWaitTimer()
      stopWatch()
      setOpen(true)
    }
  }

  function armAuth(user: User, gen: number) {
    unsubAuth.current?.()
    unsubAuth.current = onAuthStateChanged(auth, () => {
      if (watchGen.current !== gen || !awaiting.current || finished.current) return
      void user.reload().catch((err: unknown) => {
        if (watchGen.current !== gen || !awaiting.current || finished.current) return
        if (isLikelyDoneAuthCode(firebaseCode(err))) apply({ type: 'likely-done' })
      })
    })
  }

  function startWatch(armTimeout: boolean) {
    const id = uidRef.current
    if (!id || finished.current) return
    const gen = ++watchGen.current
    stopWatch()
    awaiting.current = true
    const user = auth.currentUser
    if (user && user.uid === id) armAuth(user, gen)
    unsubDoc.current = subscribeRequest(
      id,
      (snapshot) => {
        if (watchGen.current !== gen) return
        apply({ type: 'doc', snapshot })
      },
      (code) => {
        if (watchGen.current !== gen) return
        if (awaiting.current && isPermissionDenied(code)) apply({ type: 'likely-done' })
      },
    )
    if (armTimeout && stateRef.current.phase === 'pending') {
      clearWaitTimer()
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null
        if (watchGen.current !== gen) return
        apply({ type: 'timeout' })
      }, ACCOUNT_DELETION_TIMEOUT_MS)
    }
  }

  async function handleWriteError(err: unknown) {
    const code = firebaseCode(err)
    const id = uidRef.current
    if (isLikelyDoneAuthCode(code)) {
      apply({ type: 'likely-done' })
      return
    }
    if (id) {
      try {
        const snapshot = await fetchAccountDeletion(id)
        if (snapshot.status === 'missing') {
          commit({
            phase: 'confirm',
            error: 'Could not send the deletion request. Please try again.',
            serverError: false,
          })
          return
        }
        apply({ type: 'doc', snapshot })
        if (stateRef.current.phase === 'pending') startWatch(true)
        return
      } catch (readErr: unknown) {
        const readCode = firebaseCode(readErr)
        if (isPermissionDenied(readCode) || isLikelyDoneAuthCode(readCode)) {
          apply({ type: 'likely-done' })
          return
        }
      }
    }
    commit({
      phase: 'error',
      error: 'Could not send the deletion request. Please try again.',
      serverError: false,
    })
    setOpen(true)
  }

  async function openDialog() {
    const id = uidRef.current
    if (!id || finished.current) return
    setOpen(true)
    setLoading(true)
    try {
      const snapshot = await fetchAccountDeletion(id)
      apply({ type: 'doc', snapshot })
      if (stateRef.current.phase === 'pending') startWatch(timeoutRef.current === null)
      if (stateRef.current.phase === 'still-processing') startWatch(false)
    } catch (err: unknown) {
      const code = firebaseCode(err)
      const user = auth.currentUser
      if (user && (isPermissionDenied(code) || isLikelyDoneAuthCode(code))) {
        try {
          await user.reload()
          commit({ phase: 'error', error: 'Could not read the deletion request.', serverError: false })
        } catch (reloadErr: unknown) {
          if (isLikelyDoneAuthCode(firebaseCode(reloadErr))) apply({ type: 'likely-done' })
          else commit({ phase: 'error', error: 'Could not read the deletion request.', serverError: false })
        }
      } else if (isLikelyDoneAuthCode(code) || (isPermissionDenied(code) && !user)) {
        apply({ type: 'likely-done' })
      } else {
        commit({ phase: 'error', error: 'Could not read the deletion request.', serverError: false })
      }
    } finally {
      setLoading(false)
    }
  }

  function closeDialog() {
    const phase = stateRef.current.phase
    if (phase === 'pending' || phase === 'success' || loading) return
    if (phase !== 'still-processing') stopListening()
    setOpen(false)
  }

  async function confirmDelete() {
    const id = uidRef.current
    if (!id || writing.current || finished.current || stateRef.current.phase !== 'confirm') return
    writing.current = true
    apply({ type: 'create-started' })
    try {
      await createAccountDeletionRequest(id)
      startWatch(true)
    } catch (err: unknown) {
      await handleWriteError(err)
    } finally {
      writing.current = false
    }
  }

  async function retry() {
    const id = uidRef.current
    if (!id || writing.current || finished.current || stateRef.current.phase !== 'error') return
    writing.current = true
    apply({ type: 'retry-started' })
    try {
      await retryAccountDeletionRequest(id)
      startWatch(true)
    } catch (err: unknown) {
      await handleWriteError(err)
    } finally {
      writing.current = false
    }
  }

  async function checkAgain() {
    const id = uidRef.current
    if (!id || finished.current) return
    startWatch(false)
    try {
      const snapshot = await fetchAccountDeletion(id)
      apply({ type: 'doc', snapshot })
      if (stateRef.current.phase === 'pending') startWatch(timeoutRef.current === null)
      if (stateRef.current.phase === 'still-processing') startWatch(false)
    } catch (err: unknown) {
      const code = firebaseCode(err)
      if (isPermissionDenied(code) || isLikelyDoneAuthCode(code)) apply({ type: 'likely-done' })
    }
  }

  useEffect(() => {
    return () => {
      awaiting.current = false
      unsubDoc.current?.()
      unsubDoc.current = null
      unsubAuth.current?.()
      unsubAuth.current = null
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      if (signOutTimer.current !== null) {
        window.clearTimeout(signOutTimer.current)
        signOutTimer.current = null
        void signOut(auth).catch(() => {})
      }
    }
  }, [])

  return {
    open,
    loading,
    state,
    openDialog,
    closeDialog,
    confirmDelete,
    retry,
    checkAgain,
  }
}
