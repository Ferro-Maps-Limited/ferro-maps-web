import { addDoc, collection, onSnapshot, serverTimestamp, type DocumentReference } from 'firebase/firestore'
import { db, auth } from './firebase'

/**
 * Asking for a change to what the apps read.
 *
 * config/* cannot be written from a browser at all, and should not be: a write
 * there sends a push notification to every driver. The console writes a
 * request instead and onConfigRequest applies it — the same pattern as
 * suspending a driver, and for the same reason (callables cannot be invoked on
 * this project).
 *
 * Resolves when the trigger has finished, so the screen can report what
 * actually happened rather than "submitted".
 */

const TIMEOUT_MS = 15_000

export type ConfigRequestType = 'appVersion' | 'banner'

export type AppVersionPayload = {
  latestVersion: string
  updateMessage?: string
  updateEnabled?: boolean
}

export type BannerPayload = {
  title: string
  body: string
  isActive: boolean
  /** True publishes it as a new banner, which notifies every driver. */
  notify: boolean
}

export function submitConfigRequest(
  type: ConfigRequestType,
  payload: AppVersionPayload | BannerPayload,
): Promise<void> {
  return new Promise((resolve, reject) => {
    addDoc(collection(db, 'configRequests'), {
      type,
      payload,
      requestedBy: auth.currentUser?.uid ?? null,
      requestedByEmail: auth.currentUser?.email ?? null,
      requestedAt: serverTimestamp(),
      status: 'pending',
    })
      .then((ref: DocumentReference) => {
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Timed out waiting for the change to be applied.'))
        }, TIMEOUT_MS)

        const unsubscribe = onSnapshot(ref, (snap) => {
          const data = snap.data()
          if (!data || data.status === 'pending') return
          clearTimeout(timeout)
          unsubscribe()
          if (data.status === 'done') resolve()
          else reject(new Error(data.error ?? 'The change was refused.'))
        })
      })
      .catch(reject)
  })
}
