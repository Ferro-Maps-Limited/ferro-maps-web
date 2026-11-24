import { useEffect, useState } from 'react'
import { collection, doc, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore'
import { Card } from '@ferro-maps/ui'
import AppShell from '../components/AppShell'
import { db } from '../lib/firebase'
import { submitAuthorityAction, submitFundingTopUp } from '../lib/paymentActions'

// Ferro's Stripe test account (pay@ferromaps.com). Same id as
// EXPECTED_STRIPE_ACCOUNT_ID in functions/src/parking/stripeClient.ts.
const STRIPE_TEST_ACCOUNT = 'acct_1UYo41K3YqihBBbk'

interface FundingState {
  balancePence: number
  reservedPence: number
  spentTodayPence: number
  spentDay: string
  dailyCapPence: number
  paused: boolean
}

interface AuthorityJob {
  id: string
  status: string
  plate: string
  occurredOn: string
  zone: string
  chargeType: string
  authorityPence: number
  driverAmountPence: number
  paymentUrl: string
  authorityReference: string
  createdAtMs: number
  locationCode: string
  durationMinutes: number
  extendsPaymentId: string
  stayEndsAtMs: number
}

/* 30 -> "30 min", 120 -> "2 h", 90 -> "1 h 30 min". */
function formatStay(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/* 24 Nov, 15:30 in London time. */
function formatLondon(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
}

function formatPence(pence: number): string {
  const negative = pence < 0
  const abs = Math.abs(pence)
  return `${negative ? '-' : ''}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function parsePounds(input: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const pounds = Number(match[1])
  const frac = (match[2] ?? '').padEnd(2, '0')
  const pence = pounds * 100 + Number(frac)
  if (!Number.isSafeInteger(pence) || pence < 1) return null
  return pence
}

function millis(value: unknown): number {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    const stamp = value as Timestamp
    return stamp.toMillis()
  }
  return 0
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const OPEN_FIRST = ['open', 'queued', 'fulfilled', 'failed', 'already_paid', 'expired']

export default function Payments() {
  const [funding, setFunding] = useState<FundingState | null>(null)
  const [jobs, setJobs] = useState<AuthorityJob[]>([])
  const [topUpPounds, setTopUpPounds] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [references, setReferences] = useState<Record<string, string>>({})
  const [charged, setCharged] = useState<Record<string, string>>({})

  useEffect(() => {
    const unsubFunding = onSnapshot(doc(db, 'funding', 'state'), (snap) => {
      const data = snap.data()
      if (!data) {
        setFunding(null)
        return
      }
      setFunding({
        balancePence: whole(data.balancePence),
        reservedPence: whole(data.reservedPence),
        spentTodayPence: whole(data.spentTodayPence),
        spentDay: text(data.spentDay, '—'),
        dailyCapPence: whole(data.dailyCapPence) || 200_000,
        paused: data.paused === true,
      })
    })
    const unsubJobs = onSnapshot(
      query(collection(db, 'authorityPayments'), orderBy('createdAt', 'desc'), limit(40)),
      (snap) => {
        const rows = snap.docs.map((item) => {
          const data = item.data()
          return {
            id: item.id,
            status: text(data.status, 'unknown'),
            plate: text(data.plate, 'plate missing'),
            occurredOn: text(data.occurredOn, '—'),
            zone: text(data.zone, '—'),
            chargeType: text(data.chargeType, 'parking'),
            authorityPence: whole(data.authorityPence),
            driverAmountPence: whole(data.driverAmountPence),
            paymentUrl: text(data.paymentUrl),
            authorityReference: text(data.authorityReference),
            createdAtMs: millis(data.createdAt),
            locationCode: text(data.locationCode),
            durationMinutes: whole(data.durationMinutes),
            extendsPaymentId: text(data.extendsPaymentId),
            stayEndsAtMs: millis(data.stayEndsAt),
          }
        })
        rows.sort((a, b) => {
          const rank = OPEN_FIRST.indexOf(a.status) - OPEN_FIRST.indexOf(b.status)
          if (rank !== 0) return rank
          return a.createdAtMs - b.createdAtMs
        })
        setJobs(rows)
      },
    )
    return () => {
      unsubFunding()
      unsubJobs()
    }
  }, [])

  const londonToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const spentToday = funding && funding.spentDay === londonToday ? funding.spentTodayPence : 0
  const available = funding
    ? Math.min(
        Math.max(funding.balancePence - funding.reservedPence, 0),
        Math.max(funding.dailyCapPence - spentToday, 0),
      )
    : 0

  async function run(id: string, work: () => Promise<void>, ok: string) {
    setBusy(id)
    setError(null)
    setMessage(null)
    try {
      await work()
      setMessage(ok)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <AppShell title="Payments">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 md:p-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Authority payments</h1>
          <p className="mt-1 text-sm text-text-tertiary">
            Drivers pay Ferro. Record the authority payment here after you pay it on the official site. Stripe test
            account {STRIPE_TEST_ACCOUNT}. The company funding card stays outside this desk.
          </p>
        </div>

        {funding?.paused && (
          <div className="rounded-xl border border-status-danger/30 bg-status-danger/10 px-4 py-3 text-sm text-text-primary">
            Parking payments are paused. Available funding is {formatPence(available)}. Top up, then queued jobs open
            oldest first.
          </div>
        )}
        {message && <p className="text-sm text-status-success">{message}</p>}
        {error && <p className="text-sm text-status-danger">{error}</p>}

        <div className="grid gap-3 sm:grid-cols-4">
          <Card>
            <p className="text-xs text-text-tertiary">Balance</p>
            <p className="text-lg font-semibold">{funding ? formatPence(funding.balancePence) : '—'}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-tertiary">Reserved</p>
            <p className="text-lg font-semibold">{funding ? formatPence(funding.reservedPence) : '—'}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-tertiary">Available</p>
            <p className="text-lg font-semibold">{funding ? formatPence(available) : '—'}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-tertiary">Spent today</p>
            <p className="text-lg font-semibold">
              {funding ? `${formatPence(spentToday)} / ${formatPence(funding.dailyCapPence)}` : '—'}
            </p>
          </Card>
        </div>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary">Record a top-up</h2>
          <p className="mt-1 text-sm text-text-tertiary">
            Add the money on the funding card first. This only records that the balance is here. No card number.
          </p>
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault()
              const amountPence = parsePounds(topUpPounds)
              if (!amountPence) {
                setError('Enter a top-up like 50 or 50.00.')
                return
              }
              void run('topup', () => submitFundingTopUp(amountPence, note), 'Top-up recorded.')
            }}
          >
            <input
              aria-label="Top-up amount in pounds"
              inputMode="decimal"
              value={topUpPounds}
              onChange={(event) => setTopUpPounds(event.target.value)}
              placeholder="Amount in pounds"
              className="rounded-button border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              aria-label="Top-up note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Note"
              className="rounded-button border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy === 'topup'}
              className="rounded-button bg-ferro-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              Record top-up
            </button>
          </form>
        </Card>

        <div className="flex flex-col gap-3">
          {jobs.length === 0 && <p className="text-sm text-text-tertiary">No authority payments yet.</p>}
          {jobs.map((job) => {
            const actionable = job.status === 'open' || job.status === 'queued'
            return (
              <Card key={job.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-text-primary">
                      {job.plate} · {job.zone}
                    </p>
                    <p className="text-sm text-text-tertiary">
                      {job.chargeType} · {job.occurredOn} · {job.status.replace('_', ' ')}
                    </p>
                    <p className="mt-1 text-sm">
                      Authority {formatPence(job.authorityPence)} · driver paid {formatPence(job.driverAmountPence)}
                    </p>
                    {job.extendsPaymentId && (
                      <p className="text-sm font-semibold text-text-primary">
                        Added time: extend the session already bought for {job.extendsPaymentId}
                      </p>
                    )}
                    {(job.locationCode || job.durationMinutes > 0 || job.stayEndsAtMs > 0) && (
                      <p className="text-sm text-text-tertiary">
                        {[
                          job.locationCode && `Location code ${job.locationCode}`,
                          job.durationMinutes > 0 && `Parking time ${formatStay(job.durationMinutes)}`,
                          job.stayEndsAtMs > 0 && `Paid until ${formatLondon(job.stayEndsAtMs)}`,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {job.authorityReference && (
                      <p className="text-sm text-text-tertiary">Reference {job.authorityReference}</p>
                    )}
                    {job.paymentUrl && (
                      <a className="text-sm text-ferro-primary underline" href={job.paymentUrl} target="_blank" rel="noreferrer">
                        Official payment site
                      </a>
                    )}
                  </div>
                  {job.status === 'open' && (
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const reference = (references[job.id] ?? '').trim()
                        const chargedPence = parsePounds(charged[job.id] ?? '') ?? job.authorityPence
                        if (!reference) {
                          setError('Enter the authority reference.')
                          return
                        }
                        void run(
                          job.id,
                          () =>
                            submitAuthorityAction({
                              paymentIntentId: job.id,
                              action: 'fulfill',
                              authorityReference: reference,
                              authorityChargedPence: chargedPence,
                            }),
                          'Marked fulfilled.',
                        )
                      }}
                    >
                      <input
                        aria-label={`Authority reference for ${job.plate}`}
                        value={references[job.id] ?? ''}
                        onChange={(event) => setReferences({ ...references, [job.id]: event.target.value })}
                        placeholder="Authority reference"
                        className="rounded-button border border-gray-300 px-3 py-2 text-sm"
                      />
                      <input
                        aria-label={`Amount charged for ${job.plate}`}
                        value={charged[job.id] ?? (job.authorityPence / 100).toFixed(2)}
                        onChange={(event) => setCharged({ ...charged, [job.id]: event.target.value })}
                        className="rounded-button border border-gray-300 px-3 py-2 text-sm"
                      />
                      <button
                        type="submit"
                        disabled={busy === job.id}
                        className="rounded-button bg-ferro-primary px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                      >
                        Mark fulfilled
                      </button>
                    </form>
                  )}
                </div>
                {actionable && (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busy === job.id}
                      className="rounded-button border border-gray-300 px-3 py-1.5 text-sm"
                      onClick={() =>
                        void run(
                          job.id,
                          () => submitAuthorityAction({ paymentIntentId: job.id, action: 'fail' }),
                          'Marked failed. The driver is refunded.',
                        )
                      }
                    >
                      Mark failed
                    </button>
                    <button
                      type="button"
                      disabled={busy === job.id}
                      className="rounded-button border border-gray-300 px-3 py-1.5 text-sm"
                      onClick={() =>
                        void run(
                          job.id,
                          () => submitAuthorityAction({ paymentIntentId: job.id, action: 'already_paid' }),
                          'Marked already paid. The driver is refunded.',
                        )
                      }
                    >
                      Already paid
                    </button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      </div>
    </AppShell>
  )
}
