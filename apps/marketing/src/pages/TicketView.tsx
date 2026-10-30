import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { collection, addDoc, onSnapshot, serverTimestamp, type DocumentReference } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { XCircle, CheckCircle } from 'lucide-react'

interface Reply {
  text: string
  sentAt: string | { _seconds: number; _nanoseconds: number } | null
  sentBy: string
}

interface TicketData {
  ticketId: string
  ticketNumber: number
  subject: string
  message: string
  status: 'open' | 'closed'
  replies: Reply[]
  submittedAt: string | null
}

// Submits a request document and waits for the Firestore-triggered
// onTicketRequest Cloud Function to process it, resolving/rejecting based on
// the resulting status field. Same pattern as the admin app's
// submitAccountAction -- avoids onCall (blocked by org policy for public
// invokers) and avoids direct client Firestore reads (the driver visiting
// this page is never signed in, so the supportRequests auth rule would
// block a direct read regardless).
function submitTicketRequest<T>(
  type: 'validate' | 'reply',
  token: string,
  replyText?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    addDoc(collection(db, 'ticketRequests'), {
      type,
      token,
      ...(replyText ? { replyText } : {}),
      status: 'pending',
      createdAt: serverTimestamp(),
    })
      .then((requestRef: DocumentReference) => {
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Timed out. Please try again.'))
        }, 15000)

        const unsubscribe = onSnapshot(requestRef, (snap) => {
          const data = snap.data()
          if (!data || data.status === 'pending') return
          clearTimeout(timeout)
          unsubscribe()
          if (data.status === 'done') {
            resolve(data.result as T)
          } else {
            reject(new Error(data.error ?? 'Something went wrong.'))
          }
        })
      })
      .catch(reject)
  })
}

// Callable/Firestore-function responses serialize Firestore Timestamps
// differently than direct SDK reads -- this handles every shape we might
// realistically get back so dates never silently render as "Invalid Date".
function formatDate(value: string | { _seconds: number; _nanoseconds: number } | null): string {
  if (!value) return ''
  if (typeof value === 'string') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString()
  }
  if (typeof value === 'object' && '_seconds' in value) {
    return new Date(value._seconds * 1000).toLocaleDateString()
  }
  return ''
}

function formatTicketNumber(n: number): string {
  return '#' + String(n).slice(-5).padStart(5, '0')
}

export default function TicketView({ embedded = false }: { embedded?: boolean }) {
  const { token } = useParams<{ token: string }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ticketData, setTicketData] = useState<TicketData | null>(null)
  const [replyText, setReplyText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    async function loadTicket() {
      if (!token) {
        setError('This link is invalid or has expired. Please contact admin@ferromaps.com')
        setLoading(false)
        return
      }
      try {
        const result = await submitTicketRequest<TicketData>('validate', token)
        setTicketData(result)
      } catch (err) {
        console.error('TicketView error:', err)
        const message = err instanceof Error ? err.message : ''
        if (message.toLowerCase().includes('closed')) {
          setError('This ticket has been closed and can no longer be replied to.')
        } else {
          setError('This link is invalid or has expired. Please contact support@ferromaps.com')
        }
      } finally {
        setLoading(false)
      }
    }
    loadTicket()
  }, [token])

  async function handleSubmitReply() {
    if (!replyText.trim() || submitting || !ticketData || !token) return
    const trimmedReply = replyText.trim()
    setSubmitting(true)
    try {
      await submitTicketRequest<{ success: boolean }>('reply', token, trimmedReply)

      // Optimistically add the reply to the thread -- the server-written
      // version (with a real Firestore-generated sentAt) isn't reflected
      // here otherwise, since this page doesn't re-validate the ticket
      // after submit. Dedupe on sender + text since replies have no
      // stable ID to key off if something later re-syncs this list.
      const optimisticReply: Reply = {
        text: trimmedReply,
        sentAt: new Date().toISOString(),
        sentBy: 'driver',
      }
      setTicketData((prev) => {
        if (!prev) return prev
        const alreadyPresent = prev.replies.some(
          (r) => r.sentBy === 'driver' && r.text === optimisticReply.text,
        )
        if (alreadyPresent) return prev
        return { ...prev, replies: [...prev.replies, optimisticReply] }
      })

      setSubmitted(true)
      setReplyText('')
    } catch {
      setError('Failed to send reply. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`min-h-screen bg-white font-nunito${embedded ? ' v2-shift v2-prose' : ''}`}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/" className="text-ferro-primary font-bold text-2xl">Ferro Maps</a>
          <div className="border-b border-gray-200 mt-4" />
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center mt-16">
            <div className="animate-spin w-8 h-8 border-2 border-ferro-primary border-t-transparent rounded-full" />
            <p className="text-gray-500 mt-3 text-sm">Loading your ticket...</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <XCircle size={32} className="text-red-500 mx-auto mb-3" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Ticket content */}
        {!loading && !error && ticketData && (
          <>
            {/* Ticket header */}
            <div>
              <div className="flex items-center gap-3">
                <span className="font-bold text-lg">{formatTicketNumber(ticketData.ticketNumber)}</span>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  ticketData.status === 'open'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-500'
                }`}>
                  {ticketData.status === 'open' ? 'Open' : 'Closed'}
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1">{ticketData.subject}</p>
            </div>

            {/* Conversation */}
            <div className="mt-6 space-y-4">
              {/* Original message */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-700">
                <p className="text-xs text-gray-400 mb-1">
                  Your message
                  {ticketData.submittedAt && ` · ${formatDate(ticketData.submittedAt)}`}
                </p>
                <p>{ticketData.message}</p>
              </div>

              {/* Replies */}
              {ticketData.replies.map((reply, i) =>
                reply.sentBy === 'driver' ? (
                  <div key={i} className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm">
                    <p className="text-xs text-gray-400 mb-1">You · {formatDate(reply.sentAt)}</p>
                    <p className="text-gray-700">{reply.text}</p>
                  </div>
                ) : (
                  <div key={i} className="bg-ferro-tint rounded-xl p-4 text-sm">
                    <p className="text-xs text-gray-400 mb-1">Ferro Maps Support · {formatDate(reply.sentAt)}</p>
                    <p className="text-ferro-ink">{reply.text}</p>
                  </div>
                )
              )}
            </div>

            {/* Reply form */}
            {ticketData.status === 'open' && !submitted && (
              <div className="mt-8">
                <h3 className="font-semibold text-gray-800 mb-3">Send a reply</h3>
                <textarea
                  rows={4}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder="Type your reply..."
                  className="w-full rounded-lg border border-gray-300 p-3 text-sm resize-none focus:outline-none focus:border-ferro-primary"
                />
                <button
                  onClick={handleSubmitReply}
                  disabled={!replyText.trim() || submitting}
                  className="w-full mt-3 bg-ferro-primary text-white rounded-lg py-3 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Sending...' : 'Send reply'}
                </button>
              </div>
            )}

            {/* Success state */}
            {submitted && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center mt-8">
                <CheckCircle size={24} className="text-green-500 mx-auto mb-2" />
                <p className="text-green-700 font-medium">Your reply has been sent!</p>
                <p className="text-sm text-gray-500 mt-1">Our support team will get back to you soon.</p>
              </div>
            )}

            {/* Closed state */}
            {ticketData.status === 'closed' && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-center mt-8">
                <p className="text-sm text-gray-500">This ticket has been closed.</p>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <p className="mt-12 text-center text-xs text-gray-400">
          Need help? Contact us at support@ferromaps.com
        </p>
      </div>
    </div>
  )
}
