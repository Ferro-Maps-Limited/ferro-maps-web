import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'

// Same fields as the homepage contact form in Contact.tsx.
export async function submitSupportRequest(input: {
  name: string
  email: string
  message: string
  agreedToPolicy: boolean
}): Promise<void> {
  await addDoc(collection(db, 'supportRequests'), {
    name: input.name,
    email: input.email,
    message: input.message,
    agreedToPolicy: input.agreedToPolicy,
    submittedAt: serverTimestamp(),
    status: 'open',
    ticketNumber: Date.now(),
    subject: input.message.trim().slice(0, 60),
    replies: [],
  })
}
