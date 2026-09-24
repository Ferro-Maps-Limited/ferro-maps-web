import { useMemo, useState } from 'react'
import { Card } from '@ferro-maps/ui'
import { MapPin, CircleCheck, Clock, Send, ArrowUpDown } from 'lucide-react'
import AppShell from '../components/AppShell'
import VisitFeed from '../components/VisitFeed'
import { Legend } from '../components/charts'
import { categoryColor, OUTCOME_COLOR } from '../lib/chartColors'
import { formatMinutes, share, useHotspotScores, useLiveStats, type HotspotScore } from '../lib/adminStats'

type SortKey = 'visits' | 'jobRate' | 'wait' | 'alerts' | 'actedRate'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'visits', label: 'Most visited' },
  { key: 'jobRate', label: 'Best job rate' },
  { key: 'wait', label: 'Longest wait' },
  { key: 'alerts', label: 'Most alerts' },
  { key: 'actedRate', label: 'Worst alert response' },
]

const OUTCOME_LEGEND = [
  { label: 'Job within 10 min', color: OUTCOME_COLOR.jobQuick },
  { label: 'Job after a wait', color: OUTCOME_COLOR.jobSlow },
  { label: 'No job', color: OUTCOME_COLOR.noJob },
]

function jobRate(item: HotspotScore): number | null {
  return share(item.jobQuick + item.jobSlow, item.visits)
}

function sortValue(item: HotspotScore, key: SortKey): number {
  switch (key) {
    case 'jobRate':
      return item.visits === 0 ? -1 : (jobRate(item) ?? 0)
    case 'wait':
      return item.medianWaitMinutes ?? -1
    case 'alerts':
      return item.alertsSent
    case 'actedRate':
      // Worst first, and only where enough alerts went out to mean anything.
      return item.alertsSent < 3 ? 999 : (share(item.alertsActedOn, item.alertsSent) ?? 0)
    default:
      return item.visits
  }
}

/** The outcome mix as one bar, which is quicker to compare than three numbers. */
function OutcomeBar({ item }: { item: HotspotScore }) {
  const total = item.jobQuick + item.jobSlow + item.noJob
  if (total === 0) return <span className="text-text-tertiary">—</span>
  const parts = [
    { value: item.jobQuick, color: OUTCOME_COLOR.jobQuick },
    { value: item.jobSlow, color: OUTCOME_COLOR.jobSlow },
    { value: item.noJob, color: OUTCOME_COLOR.noJob },
  ]
  return (
    <div className="flex h-2.5 w-28 gap-0.5 rounded-sm overflow-hidden">
      {parts.map((part, i) =>
        part.value > 0 ? (
          <i key={i} style={{ width: `${(part.value / total) * 100}%`, backgroundColor: part.color }} />
        ) : null,
      )}
    </div>
  )
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note?: string }) {
  return (
    <Card className="!p-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
          {icon}
          {label}
        </span>
        <span className="text-2xl font-bold tabular-nums text-text-primary">{value}</span>
        {note && <span className="text-caption text-text-tertiary">{note}</span>}
      </div>
    </Card>
  )
}

type Tab = 'scoreboard' | 'visits'

export default function Hotspots() {
  const { scores, loading } = useHotspotScores()
  const { stats: live } = useLiveStats()
  const [sort, setSort] = useState<SortKey>('visits')
  const [tab, setTab] = useState<Tab>('scoreboard')

  const items = useMemo(() => {
    // "Worst alert response" is the one sort that reads best ascending.
    const ascending = sort === 'actedRate'
    return [...(scores?.items ?? [])].sort((a, b) =>
      ascending ? sortValue(a, sort) - sortValue(b, sort) : sortValue(b, sort) - sortValue(a, sort),
    )
  }, [scores, sort])

  const typicalWait = useMemo(() => {
    const waits = (scores?.items ?? [])
      .map((item) => item.medianWaitMinutes)
      .filter((wait): wait is number => wait !== null)
      .sort((a, b) => a - b)
    return waits.length === 0 ? null : waits[Math.floor(waits.length / 2)]
  }, [scores])

  // Per type, which is the level a decision gets made at: stop sending alerts
  // for a type that never pays off, or send more for one that does.
  const byCategory = useMemo(() => {
    const map = new Map<string, { visits: number; jobs: number; alertsSent: number; alertsActedOn: number }>()
    for (const item of scores?.items ?? []) {
      const entry = map.get(item.category) ?? { visits: 0, jobs: 0, alertsSent: 0, alertsActedOn: 0 }
      entry.visits += item.visits
      entry.jobs += item.jobQuick + item.jobSlow
      entry.alertsSent += item.alertsSent
      entry.alertsActedOn += item.alertsActedOn
      map.set(item.category, entry)
    }
    return [...map.entries()].sort((a, b) => b[1].visits - a[1].visits)
  }, [scores])

  const totals = scores?.totals
  const overallJobRate = totals ? share(totals.jobs, totals.visits) : null
  const overallActed = totals ? share(totals.alertsActedOn, totals.alertsSent) : null
  const driftBands = Object.entries(scores?.drift.bands ?? {})

  return (
    <AppShell title="Hotspots">
      <div className="flex flex-col gap-6">
        {!loading && !scores && (
          <Card className="bg-amber-50">
            <p className="text-label font-semibold text-text-primary mb-1">Nothing scored yet</p>
            <p className="text-body-sm text-text-secondary">
              The scoreboard is built each night from visits and alerts. It will fill in after the next run.
            </p>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat
            icon={<MapPin size={15} />}
            label="Live hotspots"
            value={live ? live.hotspots.total.toLocaleString() : '—'}
            note={live ? `plus ${live.hotspots.driverPins} pins from drivers` : undefined}
          />
          <Stat
            icon={<CircleCheck size={15} />}
            label="Visits that found a job"
            value={overallJobRate === null ? '—' : `${overallJobRate}%`}
            note={totals ? `${totals.visits} visits in ${scores?.windowDays ?? 30} days` : undefined}
          />
          <Stat
            icon={<Send size={15} />}
            label="Alerts acted on"
            value={overallActed === null ? '—' : `${overallActed}%`}
            note={totals ? `${totals.alertsSent} alerts sent` : undefined}
          />
          <Stat
            icon={<Clock size={15} />}
            label="Typical wait"
            value={formatMinutes(typicalWait)}
            note="median across hotspots"
          />
        </div>

        <div className="flex gap-1 border-b border-border-default">
          {([
            { key: 'scoreboard', label: 'By hotspot' },
            { key: 'visits', label: 'Every visit' },
          ] as const).map((option) => (
            <button
              key={option.key}
              onClick={() => setTab(option.key)}
              className={`px-3 py-2 text-label font-semibold -mb-px border-b-2 transition-colors duration-fast ${
                tab === option.key
                  ? 'text-ferro-primary border-ferro-primary'
                  : 'text-text-tertiary border-transparent hover:text-text-primary'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {tab === 'visits' ? (
          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Every visit, newest first</p>
            <p className="text-caption text-text-tertiary mb-4">
              The last hundred, as they were recorded. This is where an oddity shows itself before an average hides
              it.
            </p>
            <VisitFeed />
          </Card>
        ) : (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Which kinds of hotspot pay off</p>
            <p className="text-caption text-text-tertiary mb-4">
              Visits and jobs over the last {scores?.windowDays ?? 30} days.
            </p>
            {byCategory.length === 0 ? (
              <p className="text-body-sm text-text-tertiary">No visits recorded yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {byCategory.map(([category, entry]) => {
                  const rate = share(entry.jobs, entry.visits)
                  const busiest = Math.max(...byCategory.map(([, e]) => e.visits), 1)
                  return (
                    <div key={category} className="flex items-center gap-3">
                      <span className="flex items-center gap-2 w-32 flex-shrink-0 text-body-sm text-text-secondary capitalize">
                        <i className="w-2 h-2 rounded-full" style={{ backgroundColor: categoryColor(category) }} />
                        {category}
                      </span>
                      <div className="flex-1 h-2.5 bg-surface-sunken rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(entry.visits / busiest) * 100}%`,
                            backgroundColor: categoryColor(category),
                          }}
                        />
                      </div>
                      <span className="text-caption text-text-tertiary w-24 text-right tabular-nums">
                        {entry.visits} visit{entry.visits === 1 ? '' : 's'}
                      </span>
                      <span className="text-body-sm font-semibold text-text-primary w-12 text-right tabular-nums">
                        {rate === null ? '—' : `${rate}%`}
                      </span>
                    </div>
                  )
                })}
                <p className="text-caption text-text-tertiary">Percentage is how often a visit ended in a job.</p>
              </div>
            )}
          </Card>

          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Where drivers actually wait</p>
            <p className="text-caption text-text-tertiary mb-4">
              How far a driver moves between arriving and settling. A pin everyone walks away from is in the wrong
              place.
            </p>
            {driftBands.length === 0 ? (
              <div className="rounded-md bg-surface-raised p-4">
                <p className="text-body-sm text-text-secondary">
                  No waiting positions recorded yet. The app started collecting them recently, so this fills in as
                  drivers make trips on the newer build.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {driftBands.map(([band, count]) => {
                  const busiest = Math.max(...driftBands.map(([, c]) => c), 1)
                  return (
                    <div key={band} className="flex items-center gap-3">
                      <span className="w-16 text-body-sm text-text-secondary tabular-nums">{band} m</span>
                      <div className="flex-1 h-2.5 bg-surface-sunken rounded-full overflow-hidden">
                        <div
                          className="h-full bg-ferro-primary rounded-full"
                          style={{ width: `${(count / busiest) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-body-sm font-semibold tabular-nums text-text-primary">
                        {count}
                      </span>
                    </div>
                  )
                })}
                {scores?.drift.medianMetres !== null && (
                  <p className="text-caption text-text-tertiary">
                    Median drift {scores?.drift.medianMetres} m.
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>

        <Card>
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div>
              <p className="text-label font-semibold text-text-primary">Every hotspot drivers went to</p>
              <p className="text-caption text-text-tertiary">
                Last {scores?.windowDays ?? 30} days · {items.length} hotspots
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <ArrowUpDown size={14} className="text-text-tertiary" />
              {SORTS.map((option) => (
                <button
                  key={option.key}
                  onClick={() => setSort(option.key)}
                  className={`px-2.5 py-1 rounded-full text-caption font-semibold transition-colors duration-fast ${
                    sort === option.key
                      ? 'bg-ferro-primary text-white'
                      : 'bg-surface-sunken text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-body-sm">
              <thead>
                <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                  <th className="text-left py-2 font-semibold">Hotspot</th>
                  <th className="text-left py-2 font-semibold">Type</th>
                  <th className="text-right py-2 font-semibold">Visits</th>
                  <th className="text-left py-2 pl-4 font-semibold">Outcomes</th>
                  <th className="text-right py-2 font-semibold">Job rate</th>
                  <th className="text-right py-2 font-semibold">Wait</th>
                  <th className="text-right py-2 font-semibold">Alerts</th>
                  <th className="text-right py-2 font-semibold">Acted on</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-text-tertiary">
                      {loading ? 'Loading…' : 'No hotspots scored yet.'}
                    </td>
                  </tr>
                ) : (
                  items.map((item) => {
                    const rate = jobRate(item)
                    const acted = share(item.alertsActedOn, item.alertsSent)
                    return (
                      <tr key={item.hotspotId} className="border-t border-border-subtle">
                        <td className="py-2 pr-3 text-text-primary font-medium max-w-[260px] truncate">{item.name}</td>
                        <td className="py-2">
                          <span className="inline-flex items-center gap-2 text-text-secondary capitalize">
                            <i
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: categoryColor(item.category) }}
                            />
                            {item.category}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">{item.visits}</td>
                        <td className="py-2 pl-4">
                          <OutcomeBar item={item} />
                        </td>
                        <td className="py-2 text-right tabular-nums font-semibold text-text-primary">
                          {rate === null ? '—' : `${rate}%`}
                        </td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">
                          {item.medianWaitMinutes === null ? '—' : `${item.medianWaitMinutes} min`}
                        </td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">{item.alertsSent || '—'}</td>
                        <td className="py-2 text-right tabular-nums">
                          {acted === null ? (
                            <span className="text-text-tertiary">—</span>
                          ) : (
                            <span className={acted === 0 ? 'text-status-danger font-semibold' : 'text-text-secondary'}>
                              {acted}%
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3">
            <Legend items={OUTCOME_LEGEND} />
          </div>
        </Card>
        </>
        )}
      </div>
    </AppShell>
  )
}
