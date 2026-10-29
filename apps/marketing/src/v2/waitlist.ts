import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from '../lib/firebase'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Same document shape as pages/Waitlist.tsx. Name, phone and PCO are not written.
const WAITLIST_COUNTRY = 'United Kingdom'

export function isWaitlistEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email)
}

function encodeEmailToDocId(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

export async function joinWaitlist(email: string): Promise<'ok' | 'duplicate'> {
  const docId = encodeEmailToDocId(email)
  try {
    await setDoc(doc(db, 'waitlist', docId), {
      email,
      country: WAITLIST_COUNTRY,
      signedUpAt: serverTimestamp(),
      consentGiven: true,
    })
    return 'ok'
  } catch (unknownError: unknown) {
    const firebaseError = unknownError as { code?: string }
    if (firebaseError.code === 'permission-denied') return 'duplicate'
    throw unknownError
  }
}
