import { useState, useEffect } from 'react'
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  doc,
  updateDoc,
  arrayUnion,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { Link } from 'react-router-dom'
import { MessageSquare, X, RotateCcw, ArrowLeft, Clock, Crown, ArrowUpRight } from 'lucide-react'
import { Button } from '@ferro-maps/ui'
import AppShell from '../components/AppShell'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { toSafeDate, isTicketUnread, isWaitingOnUs, shortAge } from '../lib/utils'
import { findDriverByEmail, type DriverMatch } from '../lib/driverSearch'
import { formatMinutes, sumRange, useDailyStats, useLiveStats } from '../lib/adminStats'
import { formatDate, formatDateTime } from '../lib/driverProfile'

type Filter = 'waiting' | 'open' | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'waiting', label: 'Waiting on us' },
  { key: 'open', label: 'Open' },
  { key: 'all', label: 'All' },
]

type Reply = {
  text: string
  sentAt: Timestamp | string
  sentBy: string
}

type Ticket = {
  id: string
  ticketNumber: number
  status: 'open' | 'closed'
  name: string
  email: string
  message: string
  subject: string
  replies: Reply[]
  submittedAt: Timestamp
  lastViewedByAdminAt?: Timestamp
}

function StatusBadge({ status }: { status: 'open' | 'closed' }) {
  return status === 'open' ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
      open
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
      closed
    </span>
  )
}

function formatTicketNumber(n: number): string {
  return '#' + String(n).slice(-5).padStart(5, '0')
}

export default function Messages() {
  const { user } = useAuth()
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [selected, setSelected] = useState<Ticket | null>(null)
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>('list')
  const [filter, setFilter] = useState<Filter>('waiting')
  const [driver, setDriver] = useState<DriverMatch | null>(null)
  const { stats: live } = useLiveStats()
  const { stats: daily } = useDailyStats(30)

  // Ages are measured from when the rollup last ran, not the browser clock:
  // it is a server time, and it keeps the render pure.
  const asOf = live?.builtAt.toMillis() ?? 0

  useEffect(() => {
    const q = query(collection(db, 'supportRequests'), orderBy('submittedAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Ticket))
      setTickets(docs)
      setSelected((prev) => {
        if (!prev) return null
        return docs.find((t) => t.id === prev.id) ?? null
      })
    })
    return () => unsub()
  }, [])

  // Who the person writing in actually is. Support answers better knowing
  // whether they are a driver of two days or two months.
  useEffect(() => {
    const email = selected?.email
    if (!email) return

    let cancelled = false
    void findDriverByEmail(email).then((match) => {
      if (!cancelled) setDriver(match)
    })

    return () => {
      cancelled = true
    }
  }, [selected?.email])

  function selectTicket(ticket: Ticket) {
    setSelected(ticket)
    setMobileView('conversation')
    void updateDoc(doc(db, 'supportRequests', ticket.id), {
      lastViewedByAdminAt: serverTimestamp(),
    }).catch(() => {})
  }

  async function toggleStatus() {
    if (!selected) return
    const newStatus = selected.status === 'open' ? 'closed' : 'open'
    await updateDoc(doc(db, 'supportRequests', selected.id), { status: newStatus })
    setSelected((prev) => (prev ? { ...prev, status: newStatus } : null))
  }

  async function sendReply() {
    if (!selected || !replyText.trim()) return
    setSending(true)
    try {
      await updateDoc(doc(db, 'supportRequests', selected.id), {
        replies: arrayUnion({
          text: replyText.trim(),
          sentAt: Timestamp.now(),
          sentBy: user?.email ?? 'admin',
        }),
      })
      setReplyText('')
    } finally {
      setSending(false)
    }
  }

  const visible = tickets.filter((ticket) => {
    if (filter === 'waiting') return isWaitingOnUs(ticket)
    if (filter === 'open') return ticket.status === 'open'
    return true
  })

  const medianFirstReply = (() => {
    const week = daily.slice(-7).map((day) => day.support.firstReplyMedianMinutes).filter((m): m is number => m !== null)
    if (week.length === 0) return null
    return week.sort((a, b) => a - b)[Math.floor(week.length / 2)]
  })()
  const openedThisWeek = sumRange(daily, 7).ticketsOpened

  return (
    <AppShell title="Support">
      <div className="flex flex-col gap-4 h-full overflow-hidden">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 flex-shrink-0">
          {[
            {
              label: 'Waiting on us',
              value: live ? live.tickets.waitingOnUs.toLocaleString() : '—',
              note: live ? `${live.tickets.open} open in total` : undefined,
            },
            {
              label: 'Waiting over a day',
              value: live ? live.tickets.waitingOnUsOverDay.toLocaleString() : '—',
              note: live && live.tickets.oldestWaitingMinutes !== null
                ? `oldest ${formatMinutes(live.tickets.oldestWaitingMinutes)}`
                : undefined,
            },
            {
              label: 'Typical first reply',
              value: formatMinutes(medianFirstReply),
              note: 'median over the last week',
            },
            {
              label: 'New tickets',
              value: openedThisWeek.toLocaleString(),
              note: 'in the last 7 days',
            },
          ].map((tile) => (
            <div key={tile.label} className="bg-white border border-border-default rounded-card px-4 py-3">
              <p className="text-caption text-text-secondary">{tile.label}</p>
              <p className="text-xl font-bold tabular-nums text-text-primary">{tile.value}</p>
              {tile.note && <p className="text-caption text-text-tertiary">{tile.note}</p>}
            </div>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden border border-border-default rounded-card bg-white">
        {/* Left panel */}
        <div
          className={`w-full md:w-80 md:min-w-[320px] border-r border-gray-200 overflow-y-auto ${
            mobileView === 'conversation' ? 'hidden md:block' : 'block'
          }`}
        >
          <div className="flex gap-1 p-3 border-b border-gray-100 sticky top-0 bg-white z-10">
            {FILTERS.map((option) => (
              <button
                key={option.key}
                onClick={() => setFilter(option.key)}
                className={`px-2.5 py-1 rounded-full text-caption font-semibold transition-colors duration-fast ${
                  filter === option.key
                    ? 'bg-ferro-primary text-white'
                    : 'bg-surface-sunken text-text-secondary hover:text-text-primary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 p-8">
              <MessageSquare size={32} />
              <span className="text-sm">
                {filter === 'waiting' ? 'Nobody is waiting on a reply' : 'No tickets yet'}
              </span>
            </div>
          ) : (
            visible.map((ticket) => (
              <div
                key={ticket.id}
                onClick={() => selectTicket(ticket)}
                className={`p-4 border-b border-gray-100 cursor-pointer ${
                  selected?.id === ticket.id
                    ? 'bg-ferro-tint'
                    : isTicketUnread(ticket)
                      ? 'bg-ferro-tint'
                      : 'bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-700">
                    {formatTicketNumber(ticket.ticketNumber)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isWaitingOnUs(ticket) && asOf > 0 && (
                      <span className="inline-flex items-center gap-1 text-overline font-semibold text-status-warning">
                        <Clock size={10} />
                        {shortAge(ticket.submittedAt, asOf)}
                      </span>
                    )}
                    <StatusBadge status={ticket.status} />
                  </div>
                </div>
                <div className="text-sm text-gray-600 truncate mb-0.5">{ticket.email}</div>
                <div className="text-xs text-gray-400 truncate">
                  {ticket.message.slice(0, 60)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Right panel */}
        <div
          className={`flex-1 flex-col overflow-hidden ${
            mobileView === 'conversation' ? 'flex' : 'hidden md:flex'
          }`}
        >
          {!selected ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
              <MessageSquare size={40} />
              <span className="text-sm">Select a ticket to view</span>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMobileView('list')}
                    className="md:hidden -ml-2 mr-1 w-8 h-8 flex items-center justify-center rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors duration-fast"
                    aria-label="Back to ticket list"
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <span className="text-sm font-semibold text-gray-700">
                    {formatTicketNumber(selected.ticketNumber)}
                  </span>
                  <StatusBadge status={selected.status} />
                </div>
                {selected.status === 'open' ? (
                  <Button
                    variant="secondary"
                    onClick={toggleStatus}
                    className="border border-red-300 text-red-600 hover:bg-red-50"
                  >
                    <X size={14} className="mr-1" /> Close ticket
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={toggleStatus}
                    className="border border-green-300 text-green-600 hover:bg-green-50"
                  >
                    <RotateCcw size={14} className="mr-1" /> Reopen ticket
                  </Button>
                )}
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                <div className="text-sm font-semibold text-gray-700">{selected.subject}</div>
                <div className="text-sm text-gray-500">{selected.email}</div>

                {/* Who is writing in. Answering blind is how support ends up
                    asking a driver of two months whether they have installed
                    the app. */}
                {driver ? (
                  <div className="rounded-card border border-border-default bg-surface-raised p-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-body-sm font-semibold text-text-primary">{driver.name}</span>
                        {driver.isSuspended ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-overline font-semibold bg-red-100 text-red-700">
                            Suspended
                          </span>
                        ) : driver.isOnline ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-overline font-semibold bg-green-100 text-green-700">
                            Online
                          </span>
                        ) : null}
                        {driver.ferroBalance > 0 && (
                          <span className="inline-flex items-center gap-1 text-overline text-text-tertiary">
                            <Crown size={10} />
                            {driver.ferroBalance} ferros
                          </span>
                        )}
                      </div>
                      <Link
                        to={`/drivers/${driver.uid}`}
                        className="inline-flex items-center gap-1 text-caption font-semibold text-ferro-primary"
                      >
                        Open profile
                        <ArrowUpRight size={13} />
                      </Link>
                    </div>
                    <p className="text-caption text-text-tertiary mt-1">
                      {[
                        driver.phoneNumber,
                        driver.country,
                        driver.joinedAt ? `joined ${formatDate(driver.joinedAt)}` : null,
                        driver.suspendedAt ? `suspended ${formatDateTime(driver.suspendedAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                ) : (
                  <p className="text-caption text-text-tertiary">
                    No driver account matches this email address.
                  </p>
                )}
                <div>
                  <div className="text-xs text-gray-400 mb-1">Driver message</div>
                  <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-700">
                    {selected.message}
                  </div>
                </div>
                {selected.replies && selected.replies.length > 0 && (
                  <div className="space-y-3">
                    {selected.replies.map((reply, i) =>
                      reply.sentBy === 'driver' ? (
                        <div key={i} className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm">
                          <div className="text-xs text-gray-400 mb-1">
                            Driver reply · {toSafeDate(reply.sentAt)?.toLocaleString() ?? 'Date unknown'}
                          </div>
                          <div className="text-gray-700">{reply.text}</div>
                        </div>
                      ) : (
                        <div key={i} className="bg-ferro-tint rounded-xl p-4 text-sm">
                          <div className="text-xs text-gray-400 mb-1">
                            Admin reply · {toSafeDate(reply.sentAt)?.toLocaleString() ?? 'Date unknown'}
                          </div>
                          <div className="text-gray-700">{reply.text}</div>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="border-t border-gray-200 px-6 py-4">
                {selected.status === 'closed' ? (
                  <>
                    <textarea
                      rows={3}
                      disabled
                      className="w-full rounded-lg border border-gray-300 p-3 text-sm bg-gray-100 text-gray-400 resize-none mb-2"
                      placeholder="Reopen ticket to reply"
                    />
                    <p className="text-xs text-gray-400 text-center">Reopen ticket to reply</p>
                    <Button disabled className="w-full mt-2">
                      Send
                    </Button>
                  </>
                ) : (
                  <>
                    <textarea
                      rows={3}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 p-3 text-sm resize-none mb-2"
                      placeholder="Write a reply..."
                    />
                    <Button
                      onClick={sendReply}
                      disabled={!replyText.trim() || sending}
                      className="w-full"
                    >
                      {sending ? 'Sending…' : 'Send'}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        </div>
      </div>
    </AppShell>
  )
}
