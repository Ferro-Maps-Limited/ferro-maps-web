import { useEffect, useState } from 'react'
import { Card } from '@ferro-maps/ui'
import { doc, getDoc } from 'firebase/firestore'
import { Activity, MapPin, Smartphone, Megaphone, RefreshCw } from 'lucide-react'
import { db } from '../lib/firebase'
import AppShell from '../components/AppShell'
import { BarChart, Legend } from '../components/charts'
import { categoryColor } from '../lib/chartColors'
import { formatMinutes, minutesBetween, share, shortDay, useDailyStats, useLiveStats } from '../lib/adminStats'

type AppConfig = {
  latestVersion?: string
  bannerTitle?: string
  bannerBody?: string
  bannerActive?: boolean
}

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

  const pipelineReporting = Boolean(live?.pipeline.lastRunAt)
  const claimShare = live ? share(live.drivers.deviceClaimed, live.drivers.activeLast7d) : null
  const categories = Object.entries(live?.hotspots.byCategory ?? {}).filter(([, count]) => count > 0)

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
                    {pipelineReporting && live?.pipeline.lastRunAt
                      ? formatMinutes(minutesBetween(live.pipeline.lastRunAt, live.builtAt))
                      : 'Not reporting'}
                  </span>
                  <span className="text-caption text-text-tertiary">
                    {pipelineReporting
                      ? `ago, ${live?.pipeline.lastRunWritten ?? 0} hotspots written`
                      : 'No runs recorded'}
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
                      ? `${live.drivers.deviceClaimed.toLocaleString()} of ${live.drivers.activeLast7d.toLocaleString()} active drivers`
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
                  From hotspots_test, the collection the apps read.
                </p>
                <div className="flex flex-col">
                  {categories.length === 0 ? (
                    <p className="text-body-sm text-text-tertiary">No hotspots counted yet.</p>
                  ) : (
                    categories.map(([name, count]) => (
                      <div key={name} className="flex items-center gap-3 py-1.5">
                        <i
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: categoryColor(name) }}
                          aria-hidden="true"
                        />
                        <span className="text-body-sm text-text-secondary capitalize flex-1">{name}</span>
                        <div className="flex-1 h-2 bg-surface-sunken rounded-full overflow-hidden max-w-[180px]">
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
                        No ingest runs and no alerts have been recorded on this project, so nothing here can say how
                        the map is being kept up to date. The {live?.hotspots.total.toLocaleString() ?? 0} hotspots
                        drivers see are arriving another way.
                      </p>
                    </div>
                  )}
                </Card>
              </div>

              <Card>
                <p className="text-label font-semibold text-text-primary mb-4 flex items-center gap-2">
                  <Megaphone size={16} />
                  Release and messaging
                </p>
                <Row label="Latest app version" value={config.latestVersion ?? '—'} />
                <Row
                  label="Promo banner"
                  value={config.bannerActive ? 'Showing to drivers' : 'Off'}
                  tone={config.bannerActive ? 'good' : 'normal'}
                />
                {config.bannerTitle && (
                  <div className="mt-3 rounded-md bg-ferro-deep text-white p-3">
                    <p className="text-overline uppercase tracking-wide text-white/60">Current banner</p>
                    <p className="text-label font-semibold">{config.bannerTitle}</p>
                    <p className="text-caption text-white/80">{config.bannerBody}</p>
                  </div>
                )}
                <p className="text-caption text-text-tertiary mt-3">
                  Changing either one sends a notification to every driver, so both are still edited in the Firebase
                  console for now.
                </p>
              </Card>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
