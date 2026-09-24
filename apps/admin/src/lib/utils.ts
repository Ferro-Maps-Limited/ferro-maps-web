import { Timestamp } from 'firebase/firestore'

export function formatRelativeTime(ts: Timestamp | null): string {
  if (!ts) return 'Unknown'
  const diffSec = Math.floor((Date.now() - ts.toMillis()) / 1000)
  if (diffSec < 60) return `Updated ${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `Updated ${diffMin} min ago`
  return `Updated ${Math.floor(diffMin / 60)}h ago`
}

export type TicketReply = {
  text: string
  sentAt: Timestamp | string
  sentBy: string
}

export type UnreadTicket = {
  replies?: TicketReply[]
  lastViewedByAdminAt?: Timestamp
}

// Handles both Firestore Timestamps and legacy ISO-string sentAt values
// (some replies were written before a bug fix that now correctly writes
// Firestore Timestamps).
export function toSafeDate(sentAt: Timestamp | string | null | undefined): Date | null {
  if (!sentAt) return null
  if (sentAt instanceof Timestamp) return sentAt.toDate()
  if (typeof sentAt === 'string') {
    const parsed = new Date(sentAt)
    return isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

// A ticket is unread if it has never been replied to, or if the most recent
// driver reply is newer than the last time an admin viewed it (or it has
// never been viewed).
export function isTicketUnread(ticket: UnreadTicket): boolean {
  if (!ticket.replies || ticket.replies.length === 0) return true

  const driverReplies = ticket.replies.filter((r) => r.sentBy === 'driver')
  const lastDriverReply = driverReplies[driverReplies.length - 1]
  if (!lastDriverReply) return false

  if (!ticket.lastViewedByAdminAt) return true
  const lastViewedAt = toSafeDate(ticket.lastViewedByAdminAt)
  if (!lastViewedAt) return true

  const lastDriverReplyAt = toSafeDate(lastDriverReply.sentAt)
  if (!lastDriverReplyAt) return false

  return lastDriverReplyAt > lastViewedAt
}

/**
 * Whether a ticket is waiting on us rather than on the driver.
 *
 * "Open" alone says nothing: a ticket stays open after it has been answered.
 * The last word is what matters — ours, or theirs. Driver replies are stamped
 * "driver"; ours carry the admin's email.
 */
export function isWaitingOnUs(ticket: { status?: string; replies?: TicketReply[] }): boolean {
  if (ticket.status !== 'open') return false
  const replies = ticket.replies ?? []
  if (replies.length === 0) return true
  return replies[replies.length - 1].sentBy === 'driver'
}

/** "3 h", "2 d" — how long since a timestamp, for an age chip. */
export function shortAge(value: Timestamp | null | undefined, now: number): string {
  if (!value) return '—'
  const minutes = Math.max(0, Math.round((now - value.toMillis()) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
