import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@ferro-maps/ui'
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { categoryColor } from '../lib/chartColors'
import { formatDateTime, OUTCOME_LABEL } from '../lib/driverProfile'

/**
 * Every visit, newest first.
 *
 * The scoreboard answers "which hotspots work"; this answers "what happened
 * last night", which is the question when something looks wrong. It is also
 * where an oddity shows itself — a three-hour wait, a visit with no outcome —
 * before anyone thinks to average it away.
 */

const PAGE = 100

/** Driver names are fetched per uid, once, and only for what is on screen. */
const NAME_LIMIT = 60

type Visit = {
  id: string
  uid?: string
  hotspotId?: string
  hotspotName?: string
  category?: string
  outcome?: string
  waitMinutes?: number
  cameFromNotification?: boolean
  recordedAt?: Timestamp | null
  arrivedAt?: Timestamp | null
  source?: string
}

type OutcomeFilter = 'all' | 'job_quick' | 'job_slow' | 'no_job'

const FILTERS: { key: OutcomeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'job_quick', label: 'Job within 10 min' },
  { key: 'job_slow', label: 'Job after a wait' },
  { key: 'no_job', label: 'No job' },
]

function outcomeBadge(outcome: string | undefined) {
  const label = OUTCOME_LABEL[outcome ?? ''] ?? 'Unknown'
  if (outcome === 'job_quick') return <Badge variant="success">{label}</Badge>
  if (outcome === 'job_slow') return <Badge variant="warning">{label}</Badge>
  return <Badge variant="error">{label}</Badge>
}

export default function VisitFeed() {
  const [visits, setVisits] = useState<Visit[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<OutcomeFilter>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'hotspotOutcomes'), orderBy('recordedAt', 'desc'), limit(PAGE)),
      (snap) => {
        setVisits(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Visit))
        setLoading(false)
      },
      (error) => {
        console.error('visits could not be read:', error)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [])

  useEffect(() => {
    const missing = [...new Set(visits.map((visit) => visit.uid).filter((uid): uid is string => !!uid))]
      .filter((uid) => !(uid in names))
      .slice(0, NAME_LIMIT)
    if (missing.length === 0) return

    let cancelled = false
    void Promise.all(
      missing.map(async (uid) => {
        try {
          const snap = await getDoc(doc(db, 'users', uid))
          return [uid, (snap.data()?.name as string) ?? 'Deleted driver'] as const
        } catch {
          return [uid, 'Unknown'] as const
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setNames((previous) => ({ ...previous, ...Object.fromEntries(pairs) }))
    })

    return () => {
      cancelled = true
    }
  }, [visits, names])

  const rows = filter === 'all' ? visits : visits.filter((visit) => visit.outcome === filter)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
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
        <span className="text-caption text-text-tertiary">
          {rows.length} of the last {visits.length} visits
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-body-sm">
          <thead>
            <tr className="text-caption uppercase tracking-wide text-text-tertiary">
              <th className="text-left py-2 font-semibold">When</th>
              <th className="text-left py-2 font-semibold">Driver</th>
              <th className="text-left py-2 font-semibold">Hotspot</th>
              <th className="text-left py-2 font-semibold">Type</th>
              <th className="text-left py-2 font-semibold">Outcome</th>
              <th className="text-right py-2 font-semibold">Waited</th>
              <th className="text-left py-2 pl-4 font-semibold">Came from</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-text-tertiary">
                  {loading ? 'Loading…' : 'No visits recorded.'}
                </td>
              </tr>
            ) : (
              rows.map((visit) => (
                <tr key={visit.id} className="border-t border-border-subtle">
                  <td className="py-2 text-text-secondary whitespace-nowrap">
                    {formatDateTime(visit.recordedAt ?? visit.arrivedAt)}
                  </td>
                  <td className="py-2">
                    {visit.uid && visit.uid !== 'deleted-user' ? (
                      <Link to={`/drivers/${visit.uid}`} className="text-text-primary hover:text-ferro-primary">
                        {names[visit.uid] ?? '…'}
                      </Link>
                    ) : (
                      <span className="text-text-tertiary">Deleted driver</span>
                    )}
                  </td>
                  <td className="py-2 text-text-primary font-medium max-w-[240px] truncate">
                    {visit.hotspotName ?? visit.hotspotId ?? '—'}
                  </td>
                  <td className="py-2">
                    <span className="inline-flex items-center gap-2 text-text-secondary capitalize">
                      <i
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: categoryColor(visit.category ?? 'unknown') }}
                      />
                      {visit.category ?? '—'}
                    </span>
                  </td>
                  <td className="py-2">{outcomeBadge(visit.outcome)}</td>
                  <td
                    className={`py-2 text-right tabular-nums ${
                      (visit.waitMinutes ?? 0) > 60 ? 'text-status-danger font-semibold' : 'text-text-secondary'
                    }`}
                  >
                    {visit.waitMinutes != null ? `${visit.waitMinutes} min` : '—'}
                  </td>
                  <td className="py-2 pl-4 text-text-secondary">
                    {visit.cameFromNotification ? 'An alert' : 'The map'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-caption text-text-tertiary">
        Waits over an hour are marked: a driver who left the app running looks the same here as one who really
        waited, and the median hides both.
      </p>
    </div>
  )
}
