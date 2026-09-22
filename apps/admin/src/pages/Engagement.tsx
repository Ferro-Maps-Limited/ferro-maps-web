import { Card } from '@ferro-maps/ui'
import { Send, Eye, MousePointerClick, Gauge, TriangleAlert } from 'lucide-react'
import AppShell from '../components/AppShell'
import { categoryColor } from '../lib/chartColors'
import { share, useAlertInsights, type AlertSplit } from '../lib/adminStats'

/** Travel bands in the order a person reads them, not alphabetical. */
const TRAVEL_ORDER = ['<5', '5-10', '10-15', '15-20', '20-30', '30+']

function actedRate(split: AlertSplit): number | null {
  return share(split.actedOn, split.checked)
}

function Stat({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  note?: string
  tone?: 'bad'
}) {
  return (
    <Card className="!p-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
          {icon}
          {label}
        </span>
        <span
          className={`text-2xl font-bold tabular-nums ${tone === 'bad' ? 'text-status-danger' : 'text-text-primary'}`}
        >
          {value}
        </span>
        {note && <span className="text-caption text-text-tertiary">{note}</span>}
      </div>
    </Card>
  )
}

/** One row of the "how far is too far" chart. */
function TravelRow({ band, split, busiest }: { band: string; split: AlertSplit; busiest: number }) {
  const rate = actedRate(split)
  const dead = rate === 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-body-sm text-text-secondary tabular-nums">{band} min</span>
      <div className="flex-1 h-3 bg-surface-sunken rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${dead ? 'bg-status-danger' : 'bg-ferro-primary'}`}
          style={{ width: `${(split.sent / busiest) * 100}%` }}
        />
      </div>
      <span className="w-20 text-right text-caption text-text-tertiary tabular-nums">{split.sent} sent</span>
      <span
        className={`w-24 text-right text-body-sm font-semibold tabular-nums ${
          dead ? 'text-status-danger' : 'text-text-primary'
        }`}
      >
        {rate === null ? '—' : `${rate}% acted`}
      </span>
    </div>
  )
}

export default function Engagement() {
  const { insights, loading } = useAlertInsights()

  const totals = insights?.totals
  const openRate = totals ? share(totals.opened, totals.sent) : null
  const actRate = totals ? share(totals.actedOn, totals.checked) : null

  const travelBands = TRAVEL_ORDER.map((band) => ({ band, split: insights?.byTravel[band] })).filter(
    (entry): entry is { band: string; split: AlertSplit } => entry.split !== undefined,
  )
  const busiestTravel = Math.max(...travelBands.map((entry) => entry.split.sent), 1)

  // Everything beyond the last band anyone acted on. This is the number that
  // says how much of the sending is wasted.
  const lastLiveBand = travelBands.findIndex((entry) => (entry.split.actedOn ?? 0) === 0)
  const wasted =
    lastLiveBand === -1
      ? 0
      : travelBands.slice(lastLiveBand).reduce((sum, entry) => sum + entry.split.sent, 0)
  const wastedShare = totals ? share(wasted, totals.sent) : null

  const hours = Object.entries(insights?.byHour ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const busiestHour = Math.max(...hours.map(([, split]) => split.sent), 1)
  const categories = Object.entries(insights?.byCategory ?? {}).sort(([, a], [, b]) => b.sent - a.sent)
  const scores = Object.entries(insights?.byScore ?? {}).sort(([a], [b]) => Number(a) - Number(b))
  const busiestScore = Math.max(...scores.map(([, split]) => split.sent), 1)

  return (
    <AppShell title="Engagement">
      <div className="flex flex-col gap-6">
        {!loading && !insights && (
          <Card className="bg-amber-50">
            <p className="text-label font-semibold text-text-primary mb-1">Nothing analysed yet</p>
            <p className="text-body-sm text-text-secondary">
              Alerts are analysed each night. This fills in after the next run.
            </p>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat
            icon={<Send size={15} />}
            label="Alerts sent"
            value={totals ? totals.sent.toLocaleString() : '—'}
            note={`last ${insights?.windowDays ?? 30} days`}
          />
          <Stat
            icon={<Eye size={15} />}
            label="Opened"
            value={openRate === null ? '—' : `${openRate}%`}
            note={totals ? `${totals.opened} of ${totals.sent}` : undefined}
          />
          <Stat
            icon={<MousePointerClick size={15} />}
            label="Drivers went"
            value={actRate === null ? '—' : `${actRate}%`}
            note={totals ? `${totals.actedOn} of ${totals.checked} where we know` : undefined}
            tone={actRate !== null && actRate < 15 ? 'bad' : undefined}
          />
          <Stat
            icon={<Gauge size={15} />}
            label="Hit the daily limit"
            value={insights ? insights.budget.atCap.toLocaleString() : '—'}
            note={insights ? `of ${insights.budget.driversNotified} drivers alerted` : undefined}
          />
        </div>

        <Card>
          <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
            <p className="text-label font-semibold text-text-primary">How far is too far</p>
            <span className="text-caption text-text-tertiary">
              share of alerts drivers acted on, by estimated travel time
            </span>
          </div>
          <p className="text-caption text-text-tertiary mb-4">
            Red bars are bands where not one driver went.
          </p>

          {travelBands.length === 0 ? (
            <p className="text-body-sm text-text-tertiary">No alerts recorded yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {travelBands.map((entry) => (
                <TravelRow key={entry.band} band={entry.band} split={entry.split} busiest={busiestTravel} />
              ))}
            </div>
          )}

          {wasted > 0 && wastedShare !== null && (
            <div className="mt-5 flex gap-3 rounded-md bg-amber-50 p-4">
              <TriangleAlert size={18} className="text-status-warning flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-body-sm font-semibold text-text-primary">
                  {wasted} of {totals?.sent} alerts ({wastedShare}%) went to places nobody drove to
                </p>
                <p className="text-body-sm text-text-secondary">
                  Every alert past {travelBands[lastLiveBand]?.band} minutes was ignored. Sending fewer, closer alerts
                  would cost drivers less attention and would not lose a single journey.
                </p>
              </div>
            </div>
          )}
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">When alerts go out</p>
            <p className="text-caption text-text-tertiary mb-4">By hour of the London day.</p>
            {hours.length === 0 ? (
              <p className="text-body-sm text-text-tertiary">No alerts recorded yet.</p>
            ) : (
              <div className="flex items-end gap-1 h-40">
                {hours.map(([hour, split]) => {
                  const rate = actedRate(split)
                  return (
                    <div key={hour} className="flex-1 flex flex-col items-center gap-1 justify-end h-full">
                      <div
                        className="w-full rounded-t-sm bg-ferro-primary/25 relative flex items-end"
                        style={{ height: `${(split.sent / busiestHour) * 100}%`, minHeight: '3px' }}
                        title={`${hour}:00 — ${split.sent} sent, ${split.actedOn} acted on`}
                      >
                        {split.actedOn > 0 && (
                          <div
                            className="w-full rounded-t-sm bg-ferro-primary"
                            style={{ height: `${Math.max(8, ((rate ?? 0) / 100) * 100)}%` }}
                          />
                        )}
                      </div>
                      <span className="text-[9px] text-text-tertiary tabular-nums">{hour}</span>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="text-caption text-text-tertiary mt-3">
              Pale is sent, solid is the share drivers acted on.
            </p>
          </Card>

          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Which kinds of alert work</p>
            <p className="text-caption text-text-tertiary mb-4">Sent, opened and acted on by hotspot type.</p>
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                  <th className="text-left py-2 font-semibold">Type</th>
                  <th className="text-right py-2 font-semibold">Sent</th>
                  <th className="text-right py-2 font-semibold">Opened</th>
                  <th className="text-right py-2 font-semibold">Went</th>
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-text-tertiary">
                      Nothing yet.
                    </td>
                  </tr>
                ) : (
                  categories.map(([category, split]) => {
                    const rate = actedRate(split)
                    return (
                      <tr key={category} className="border-t border-border-subtle">
                        <td className="py-2">
                          <span className="inline-flex items-center gap-2 text-text-primary capitalize">
                            <i
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: categoryColor(category) }}
                            />
                            {category}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">{split.sent}</td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">
                          {share(split.opened, split.sent) ?? 0}%
                        </td>
                        <td
                          className={`py-2 text-right tabular-nums font-semibold ${
                            rate === 0 ? 'text-status-danger' : 'text-text-primary'
                          }`}
                        >
                          {rate === null ? '—' : `${rate}%`}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </Card>
        </div>

        <Card>
          <p className="text-label font-semibold text-text-primary mb-1">Does the score predict anything</p>
          <p className="text-caption text-text-tertiary mb-4">
            Alerts are only sent above a scoring threshold. If drivers respond the same either side of it, the
            threshold is not earning its keep.
          </p>
          {scores.length === 0 ? (
            <p className="text-body-sm text-text-tertiary">No scored alerts yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {scores.map(([band, split]) => {
                const rate = actedRate(split)
                return (
                  <div key={band} className="flex items-center gap-3">
                    <span className="w-12 text-body-sm text-text-secondary tabular-nums">{band}</span>
                    <div className="flex-1 h-2.5 bg-surface-sunken rounded-full overflow-hidden">
                      <div
                        className="h-full bg-ferro-deep rounded-full"
                        style={{ width: `${(split.sent / busiestScore) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 text-right text-caption text-text-tertiary tabular-nums">
                      {split.sent} sent
                    </span>
                    <span className="w-20 text-right text-body-sm font-semibold tabular-nums text-text-primary">
                      {rate === null ? '—' : `${rate}% acted`}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {insights && insights.visits.fromAlert.visits < insights.visits.fromMap.visits / 10 && (
          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">One number to treat carefully</p>
            <p className="text-body-sm text-text-secondary">
              Only {insights.visits.fromAlert.visits} of{' '}
              {insights.visits.fromAlert.visits + insights.visits.fromMap.visits} recorded visits are marked as having
              come from an alert, while {insights.totals.actedOn} alerts were judged acted on. The app sets that mark
              only when a driver opens the hotspot straight from the notification, so it undercounts. Compare the two
              with that in mind, or ask the app teams to set it whenever a visit follows an alert.
            </p>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
