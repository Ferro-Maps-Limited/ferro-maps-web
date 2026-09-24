import { useEffect, useState } from 'react'
import { Card } from '@ferro-maps/ui'
import { doc, getDoc } from 'firebase/firestore'
import { Activity, MapPin, Smartphone, RefreshCw } from 'lucide-react'
import { db } from '../lib/firebase'
import AppShell from '../components/AppShell'
import { BarChart, Legend } from '../components/charts'
import ReleaseControls, { type AppConfig } from '../components/ReleaseControls'
import { categoryColor } from '../lib/chartColors'
import { formatMinutes, minutesBetween, share, shortDay, useDailyStats, useLiveStats } from '../lib/adminStats'

/** The two config documents the apps read. Neither is writable from here. */
function useAppConfig() {
  const [config, setConfig] = useState<AppConfig>({})

  useEffect(() => {
    void (async () => {
      const [version, banner] = await Promise.all([
        getDoc(doc(db, 'config', 'appVersion')).catch(() => null),
        getDoc(doc(db, 'config', 'activeBanner')).catch(() => null),
      ])
      setConfig({
        latestVersion: version?.data()?.latestVersion,
        updateMessage: version?.data()?.updateMessage,
        bannerTitle: banner?.data()?.title,
        bannerBody: banner?.data()?.body,
        bannerActive: banner?.data()?.isActive,
      })
    })()
  }, [])

  return config
}

function Row({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'good' | 'bad' }) {
  const valueColor =
    tone === 'good' ? 'text-status-success' : tone === 'bad' ? 'text-status-danger' : 'text-text-primary'
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle last:border-0">
      <span className="text-body-sm text-text-tertiary">{label}</span>
      <span className={`text-body-sm font-semibold tabular-nums text-right ${valueColor}`}>{value}</span>
    </div>
  )
}

export default function SystemHealth() {
  const { stats: live, loading } = useLiveStats()
  const { stats: daily } = useDailyStats(14)
  const config = useAppConfig()

  const claimShare = live ? share(live.drivers.deviceClaimed, live.drivers.total) : null
  const categories = Object.entries(live?.hotspots.byCategory ?? {}).filter(([, count]) => count > 0)

  // Each Cloud Run job fills its own categories, so the age of a category's
  // newest hotspot is how a stopped job announces itself.
  function feedAge(category: string): string {
    const feed = live?.hotspots.feeds?.[category]
    if (!live || !feed?.lastFetchedAt) return 'No arrival time recorded'
    const age = minutesBetween(feed.lastFetchedAt, live.builtAt)
    return age > 24 * 60 ? `Last arrived ${formatMinutes(age)} ago — check the job` : `Last arrived ${formatMinutes(age)} ago`
  }

  return (
    <AppShell title="System health">
      <div className="flex flex-col gap-6">
        {loading ? (
          <div className="h-24 bg-surface-raised animate-pulse rounded-card" />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <Card className="!p-4">
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
                    <MapPin size={15} />
                    Live hotspots
                  </span>
                  <span className="text-2xl font-bold tabular-nums text-text-primary">
                    {live ? live.hotspots.total.toLocaleString() : '—'}
                  </span>
                  <span className="text-caption text-text-tertiary">
                    plus {live?.hotspots.driverPins.toLocaleString() ?? 0} pins from drivers
                  </span>
                </div>
              </Card>

              <Card className="!p-4">
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
                    <RefreshCw size={15} />
                    Last demand update
                  </span>
                  <span className="text-2xl font-bold tabular-nums text-text-primary">
                    {live?.hotspots.lastFetchedAt
                      ? formatMinutes(minutesBetween(live.hotspots.lastFetchedAt, live.builtAt))
                      : '—'}
                  </span>
                  <span className="text-caption text-text-tertiary">
                    {live?.hotspots.lastFetchedAt ? 'since the newest hotspot arrived' : 'Nothing stamped yet'}
                  </span>
                </div>
              </Card>

              <Card className="!p-4">
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
                    <Smartphone size={15} />
                    On the current app build
                  </span>
                  <span className="text-2xl font-bold tabular-nums text-text-primary">
                    {claimShare === null ? '—' : `${claimShare}%`}
                  </span>
                  <span className="text-caption text-text-tertiary">
                    {live
                      ? `${live.drivers.deviceClaimed.toLocaleString()} of ${live.drivers.total.toLocaleString()} drivers`
                      : ''}
                  </span>
                </div>
              </Card>

              <Card className="!p-4">
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
                    <Activity size={15} />
                    Requests stuck
                  </span>
                  <span className="text-2xl font-bold tabular-nums text-text-primary">
                    {live
                      ? Object.values(live.queues ?? {})
                          .reduce((sum, queue) => sum + queue.pending, 0)
                          .toLocaleString()
                      : '—'}
                  </span>
                  <span className="text-caption text-text-tertiary">across all six request queues</span>
                </div>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <p className="text-label font-semibold text-text-primary mb-1">What is on the map</p>
                <p className="text-caption text-text-tertiary mb-4">
                  Filled by the scheduled Google Cloud jobs. A row that has not refreshed for hours is the job to go
                  and look at.
                </p>
                <div className="flex flex-col">
                  {categories.length === 0 ? (
                    <p className="text-body-sm text-text-tertiary">No hotspots counted yet.</p>
                  ) : (
                    categories.map(([name, count]) => (
                      <div key={name} className="flex items-center gap-3 py-2 border-b border-border-subtle last:border-0">
                        <i
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: categoryColor(name) }}
                          aria-hidden="true"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-body-sm text-text-secondary capitalize">{name}</p>
                          <p className="text-caption text-text-tertiary">{feedAge(name)}</p>
                        </div>
                        <div className="h-2 bg-surface-sunken rounded-full overflow-hidden w-20 sm:w-28 flex-shrink-0">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${(count / Math.max(...categories.map(([, c]) => c))) * 100}%`,
                              backgroundColor: categoryColor(name),
                            }}
                          />
                        </div>
                        <span className="text-body-sm font-semibold tabular-nums text-text-primary w-14 text-right">
                          {count.toLocaleString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </Card>

              <Card>
                <p className="text-label font-semibold text-text-primary mb-1">Requests waiting to be processed</p>
                <p className="text-caption text-text-tertiary mb-4">
                  A driver writes a request, a background job answers it. Anything sitting here for long means a job
                  has stopped.
                </p>
                <div className="flex flex-col">
                  {Object.entries(live?.queues ?? {}).map(([name, queue]) => (
                    <Row
                      key={name}
                      label={name}
                      value={
                        queue.pending === 0
                          ? 'Clear'
                          : `${queue.pending} pending · oldest ${formatMinutes(queue.oldestMinutes)}`
                      }
                      tone={queue.pending === 0 ? 'good' : queue.oldestMinutes && queue.oldestMinutes > 30 ? 'bad' : 'normal'}
                    />
                  ))}
                </div>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2">
                <Card className="h-full">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-label font-semibold text-text-primary">Hotspots added by the demand feed</p>
                    <span className="text-caption text-text-tertiary">last {daily.length} days</span>
                  </div>
                  {live && live.hotspots.expired > 0 && (
                    <p className="text-caption text-text-tertiary mt-3">
                      {live.hotspots.expired.toLocaleString()} pins are past their expiry but still in the
                      collection.
                    </p>
                  )}
                  {daily.some((d) => d.pipeline.written > 0) ? (
                    <>
                      <BarChart
                        height={180}
                        labels={daily.map((d) => shortDay(d.dayKey))}
                        seriesNames={['Hotspots written']}
                        colors={['#0E9BF7']}
                        values={daily.map((d) => [d.pipeline.written])}
                      />
                      <Legend items={[{ label: 'Hotspots written', color: '#0E9BF7' }]} />
                    </>
                  ) : (
                    <div className="rounded-md bg-amber-50 p-4">
                      <p className="text-body-sm font-semibold text-text-primary mb-1">
                        The demand feed is not reporting
                      </p>
                      <p className="text-body-sm text-text-secondary">
                        Nothing writes ingest records on this project. The {live?.hotspots.total.toLocaleString() ?? 0}{' '}
                        hotspots drivers see come from the scheduled Google Cloud jobs
                        (ferro-api-football-job, ferro-maps-data-pipeline-job, ferro-transfer-job,
                        ferro-transport-data-job), which report to Cloud Run rather than here. Until they write a run
                        record, the arrival times above are the way to tell whether they are still working.
                      </p>
                    </div>
                  )}
                </Card>
              </div>

              <Card>
                <ReleaseControls config={config} drivers={live?.drivers.total ?? null} />
              </Card>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
