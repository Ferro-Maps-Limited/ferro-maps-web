import { addDoc, collection, onSnapshot, serverTimestamp, type DocumentReference } from 'firebase/firestore'
import { auth, db } from './firebase'

const TIMEOUT_MS = 20_000

function waitForRequest(ref: DocumentReference): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for the payments desk.'))
    }, TIMEOUT_MS)
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const data = snap.data()
        if (!data || data.status === 'pending') return
        clearTimeout(timeout)
        unsubscribe()
        if (data.status === 'done') resolve()
        else reject(new Error(typeof data.error === 'string' ? data.error : 'The request was refused.'))
      },
      (err) => {
        clearTimeout(timeout)
        unsubscribe()
        reject(err)
      },
    )
  })
}

export function submitFundingTopUp(amountPence: number, note: string): Promise<void> {
  const requestedBy = auth.currentUser?.uid
  if (!requestedBy) return Promise.reject(new Error('Sign in again before recording a top-up.'))
  const body: Record<string, unknown> = {
    requestedBy,
    amountPence,
    status: 'pending',
    createdAt: serverTimestamp(),
  }
  if (note.trim()) body.note = note.trim()
  return addDoc(collection(db, 'fundingTopUpRequests'), body).then(waitForRequest)
}

export function submitAuthorityAction(input: {
  paymentIntentId: string
  action: 'fulfill' | 'fail' | 'already_paid'
  authorityReference?: string
  authorityChargedPence?: number
}): Promise<void> {
  const requestedBy = auth.currentUser?.uid
  if (!requestedBy) return Promise.reject(new Error('Sign in again before updating a payment.'))
  const body: Record<string, unknown> = {
    requestedBy,
    paymentIntentId: input.paymentIntentId,
    action: input.action,
    status: 'pending',
    createdAt: serverTimestamp(),
  }
  if (input.authorityReference) body.authorityReference = input.authorityReference
  if (input.authorityChargedPence !== undefined) body.authorityChargedPence = input.authorityChargedPence
  return addDoc(collection(db, 'authorityPaymentActionRequests'), body).then(waitForRequest)
}
