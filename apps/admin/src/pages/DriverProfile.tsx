import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Card, Badge } from '@ferro-maps/ui'
import { ArrowLeft, Bell, Crown, Smartphone, Star, Coins, MapPin, Flame } from 'lucide-react'
import AppShell from '../components/AppShell'
import { submitAccountAction, type AccountActionType } from '../lib/accountActions'
import { getLevelProgress } from '../lib/levelThresholds'
import { categoryColor } from '../lib/chartColors'
import { share } from '../lib/adminStats'
import {
  formatDate,
  formatDateTime,
  OUTCOME_LABEL,
  useDriver,
  useDriverHistory,
  type DriverDoc,
} from '../lib/driverProfile'

type Tab = 'visits' | 'alerts' | 'contributions' | 'account'

const TABS: { id: Tab; label: string }[] = [
  { id: 'visits', label: 'Visits' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'contributions', label: 'Contributions' },
  { id: 'account', label: 'Account log' },
]

function initials(name: string | undefined): string {
  if (!name) return '??'
  const parts = name.trim().split(/\s+/)
  return (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

function outcomeBadge(outcome: string | undefined) {
  const label = OUTCOME_LABEL[outcome ?? ''] ?? 'Unknown'
  if (outcome === 'job_quick') return <Badge variant="success">{label}</Badge>
  if (outcome === 'job_slow') return <Badge variant="warning">{label}</Badge>
  return <Badge variant="error">{label}</Badge>
}

function premiumUntil(driver: DriverDoc): string | null {
  if (!driver.subscriptionExpiresAt) return null
  return driver.subscriptionExpiresAt.toMillis() > Date.now() ? formatDate(driver.subscriptionExpiresAt) : null
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-caption text-text-tertiary">
        {icon}
        {label}
      </span>
      <span className="text-xl font-bold tabular-nums text-text-primary">{value}</span>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle last:border-0">
      <span className="text-body-sm text-text-tertiary">{label}</span>
      <span className="text-body-sm font-semibold text-text-primary text-right">{value}</span>
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="text-body-sm text-text-tertiary py-6 text-center">{children}</p>
}

export default function DriverProfile() {
  const { uid } = useParams<{ uid: string }>()
  const { driver, loading } = useDriver(uid)
  const { profile, loading: historyLoading } = useDriverHistory(uid)
  const [tab, setTab] = useState<Tab>('visits')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: AccountActionType) {
    if (!uid) return
    setBusy(true)
    setError(null)
    try {
      await submitAccountAction(action, uid)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <AppShell title="Driver">
        <div className="h-40 bg-surface-raised animate-pulse rounded-card" />
      </AppShell>
    )
  }

  if (!driver) {
    return (
      <AppShell title="Driver">
        <Card>
          <p className="text-label font-semibold text-text-primary mb-1">No such driver</p>
          <p className="text-body-sm text-text-secondary mb-4">
            This account may have been deleted. Deleting a driver removes the account but keeps their anonymised
            visit history.
          </p>
          <Link to="/drivers">
            <Button variant="secondary">Back to drivers</Button>
          </Link>
        </Card>
      </AppShell>
    )
  }

  const progress = getLevelProgress(driver.xp ?? 0)
  const premium = premiumUntil(driver)
  const visits = profile?.visits ?? []
  const alerts = profile?.alerts ?? []
  const jobs = visits.filter((v) => v.outcome === 'job_quick' || v.outcome === 'job_slow').length
  const jobShare = share(jobs, visits.length)
  const actedOn = alerts.filter((a) => a.actedOn).length
  const alertShare = share(actedOn, alerts.filter((a) => a.checked).length)

  return (
    <AppShell title={driver.name ?? 'Driver'}>
      <div className="flex flex-col gap-6">
        <Link to="/drivers" className="inline-flex items-center gap-1.5 text-body-sm text-text-tertiary hover:text-text-primary w-fit">
          <ArrowLeft size={15} />
          All drivers
        </Link>

        <Card>
          <div className="flex flex-col lg:flex-row lg:items-center gap-6">
            <div className="flex items-center gap-4 flex-1 min-w-0">
              <div className="w-14 h-14 rounded-full bg-ferro-deep flex items-center justify-center flex-shrink-0">
                <span className="text-white text-subtitle font-bold">{initials(driver.name)}</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-title font-bold text-text-primary truncate">{driver.name ?? 'Unnamed'}</p>
                  {driver.isSuspended ? (
                    <Badge variant="error">Suspended</Badge>
                  ) : driver.isOnline ? (
                    <Badge variant="success">Online</Badge>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">
                      Offline
                    </span>
                  )}
                  {premium && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-ferro-deep text-ferro-signal">
                      <Crown size={12} />
                      Premium to {premium}
                    </span>
                  )}
                </div>
                <p className="text-body-sm text-text-tertiary mt-1 truncate">
                  {[driver.phoneNumber, driver.email, driver.country].filter(Boolean).join(' · ') || 'No contact details'}
                </p>
                <p className="text-caption text-text-tertiary">
                  Joined {formatDate(driver.createdAt)} · last active {formatDateTime(driver.lastActiveAt)}
                </p>
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" disabled={busy} onClick={() => void run('resetStats')}>
                Reset stats
              </Button>
              {driver.isSuspended ? (
                <Button disabled={busy} onClick={() => void run('unsuspend')}>
                  Unsuspend
                </Button>
              ) : (
                <Button variant="secondary" disabled={busy} onClick={() => void run('suspend')}>
                  Suspend
                </Button>
              )}
            </div>
          </div>

          {error && <p className="text-body-sm text-status-danger mt-3">{error}</p>}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mt-6 pt-6 border-t border-border-subtle">
            <Metric icon={<Star size={13} />} label="Level" value={`${progress.current.level} · ${progress.current.name}`} />
            <Metric icon={<Flame size={13} />} label="Day streak" value={`${driver.dayStreak ?? 0}`} />
            <Metric icon={<Coins size={13} />} label="Ferros" value={`${driver.ferroBalance ?? 0}`} />
            <Metric icon={<MapPin size={13} />} label="Visits logged" value={`${visits.length}`} />
            <Metric icon={<Bell size={13} />} label="Alerts acted on" value={alertShare === null ? '—' : `${alertShare}%`} />
            <Metric icon={<Star size={13} />} label="Visits with a job" value={jobShare === null ? '—' : `${jobShare}%`} />
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Card className="h-full">
              <div className="flex gap-1 border-b border-border-default mb-4">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    className={`px-3 py-2 text-label font-semibold -mb-px border-b-2 transition-colors duration-fast ${
                      tab === item.id
                        ? 'text-ferro-primary border-ferro-primary'
                        : 'text-text-tertiary border-transparent hover:text-text-primary'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {historyLoading ? (
                <div className="h-32 bg-surface-raised animate-pulse rounded-md" />
              ) : (
                <div className="overflow-x-auto">
                  {tab === 'visits' &&
                    (visits.length === 0 ? (
                      <Empty>No visits recorded for this driver.</Empty>
                    ) : (
                      <table className="w-full text-body-sm">
                        <thead>
                          <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                            <th className="text-left py-2 font-semibold">When</th>
                            <th className="text-left py-2 font-semibold">Hotspot</th>
                            <th className="text-left py-2 font-semibold">Outcome</th>
                            <th className="text-right py-2 font-semibold">Waited</th>
                            <th className="text-left py-2 pl-4 font-semibold">Came from</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visits.map((visit) => (
                            <tr key={visit.id} className="border-t border-border-subtle">
                              <td className="py-2 text-text-secondary whitespace-nowrap">
                                {formatDateTime(visit.recordedAt ?? visit.arrivedAt)}
                              </td>
                              <td className="py-2 text-text-primary font-medium">
                                <span className="inline-flex items-center gap-2">
                                  <i
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: categoryColor(visit.category ?? 'unknown') }}
                                  />
                                  {visit.hotspotName ?? visit.hotspotId ?? '—'}
                                </span>
                              </td>
                              <td className="py-2">{outcomeBadge(visit.outcome)}</td>
                              <td className="py-2 text-right tabular-nums text-text-secondary">
                                {visit.waitMinutes != null ? `${visit.waitMinutes} min` : '—'}
                              </td>
                              <td className="py-2 pl-4 text-text-secondary">
                                {visit.cameFromNotification ? 'An alert' : 'The map'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ))}

                  {tab === 'alerts' &&
                    (alerts.length === 0 ? (
                      <Empty>No alerts have been sent to this driver.</Empty>
                    ) : (
                      <table className="w-full text-body-sm">
                        <thead>
                          <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                            <th className="text-left py-2 font-semibold">Sent</th>
                            <th className="text-left py-2 font-semibold">Type</th>
                            <th className="text-right py-2 font-semibold">Travel</th>
                            <th className="text-right py-2 font-semibold">Jobs expected</th>
                            <th className="text-left py-2 pl-4 font-semibold">What happened</th>
                          </tr>
                        </thead>
                        <tbody>
                          {alerts.map((alert) => (
                            <tr key={alert.id} className="border-t border-border-subtle">
                              <td className="py-2 text-text-secondary whitespace-nowrap">{formatDateTime(alert.sentAt)}</td>
                              <td className="py-2 text-text-primary capitalize">
                                <span className="inline-flex items-center gap-2">
                                  <i
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: categoryColor(alert.category ?? 'unknown') }}
                                  />
                                  {alert.category ?? '—'}
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums text-text-secondary">
                                {alert.travelMinutes != null ? `${alert.travelMinutes} min` : '—'}
                              </td>
                              <td className="py-2 text-right tabular-nums text-text-secondary">
                                {alert.estimatedJobs ?? '—'}
                              </td>
                              <td className="py-2 pl-4">
                                {alert.actedOn ? (
                                  <Badge variant="success">Went</Badge>
                                ) : alert.opened ? (
                                  <Badge variant="warning">Opened only</Badge>
                                ) : alert.checked ? (
                                  <Badge variant="error">Ignored</Badge>
                                ) : (
                                  <span className="text-text-tertiary">Too soon to say</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ))}

                  {tab === 'contributions' &&
                    (profile?.contributions.length === 0 ? (
                      <Empty>This driver has not added any parking bays or eggs.</Empty>
                    ) : (
                      <table className="w-full text-body-sm">
                        <thead>
                          <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                            <th className="text-left py-2 font-semibold">Added</th>
                            <th className="text-left py-2 font-semibold">What</th>
                            <th className="text-right py-2 font-semibold">Confirmed by others</th>
                            <th className="text-left py-2 pl-4 font-semibold">Last confirmed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {profile?.contributions.map((item) => (
                            <tr key={item.id} className="border-t border-border-subtle">
                              <td className="py-2 text-text-secondary whitespace-nowrap">{formatDate(item.createdAt)}</td>
                              <td className="py-2 text-text-primary">{item.description ?? item.category ?? '—'}</td>
                              <td className="py-2 text-right tabular-nums text-text-secondary">
                                {Math.max(0, (item.confirmCount ?? 1) - 1)}
                              </td>
                              <td className="py-2 pl-4 text-text-secondary">{formatDate(item.lastConfirmedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ))}

                  {tab === 'account' &&
                    (profile?.actions.length === 0 ? (
                      <Empty>Nobody has suspended, reset or deleted this account.</Empty>
                    ) : (
                      <table className="w-full text-body-sm">
                        <thead>
                          <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                            <th className="text-left py-2 font-semibold">When</th>
                            <th className="text-left py-2 font-semibold">Action</th>
                            <th className="text-left py-2 font-semibold">Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {profile?.actions.map((action) => (
                            <tr key={action.id} className="border-t border-border-subtle">
                              <td className="py-2 text-text-secondary whitespace-nowrap">
                                {formatDateTime(action.requestedAt)}
                              </td>
                              <td className="py-2 text-text-primary capitalize">{action.type ?? '—'}</td>
                              <td className="py-2">
                                {action.status === 'done' ? (
                                  <Badge variant="success">Done</Badge>
                                ) : action.status === 'error' ? (
                                  <Badge variant="error">{action.error ?? 'Failed'}</Badge>
                                ) : (
                                  <Badge variant="warning">Pending</Badge>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ))}
                </div>
              )}
            </Card>
          </div>

          <div className="flex flex-col gap-4">
            <Card>
              <p className="text-label font-semibold text-text-primary mb-3">Level progress</p>
              <div className="flex items-center justify-between text-body-sm mb-1.5">
                <span className="text-text-secondary tabular-nums">{driver.xp ?? 0} XP</span>
                <span className="text-text-tertiary">
                  {progress.next ? `${progress.next.name} at ${progress.next.xpToReach}` : 'Top level'}
                </span>
              </div>
              <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                <div className="h-full bg-ferro-primary rounded-full" style={{ width: `${progress.progressPercent}%` }} />
              </div>
              <p className="text-caption text-text-tertiary mt-2">
                Reward at this level: {progress.current.reward} · {profile?.earningsCount ?? 0} ferro awards recorded
              </p>
            </Card>

            <Card>
              <p className="text-label font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Bell size={15} />
                Alerts today
              </p>
              <div className="flex gap-1.5 mb-2">
                {[0, 1, 2].map((slot) => (
                  <span
                    key={slot}
                    className={`flex-1 h-2 rounded-full ${
                      slot < (profile?.budget?.notificationsToday ?? 0) ? 'bg-ferro-primary' : 'bg-surface-sunken'
                    }`}
                  />
                ))}
              </div>
              <p className="text-body-sm text-text-secondary">
                {profile?.budget?.notificationsToday ?? 0} of 3 used
                {profile?.budget?.lastNotifiedAt ? ` · last at ${formatDateTime(profile.budget.lastNotifiedAt)}` : ''}
              </p>
              <p className="text-caption text-text-tertiary mt-1">
                Drivers get at most three proximity alerts a day, and the same place is not repeated for hours.
              </p>
            </Card>

            <Card>
              <p className="text-label font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Smartphone size={15} />
                Device and subscription
              </p>
              <Field label="Device claimed" value={formatDate(driver.deviceClaimedAt)} />
              <Field
                label="On current build"
                value={driver.deviceClaimedAt ? 'Yes' : 'No — loses access after 15 Oct'}
              />
              <Field label="Premium until" value={premium ?? 'Not subscribed'} />
              <Field label="Plan" value={driver.premiumProductId?.split('.').pop() ?? '—'} />
              <Field label="Last verification" value={profile?.subscriptionStatus ?? 'None requested'} />
              <Field label="Saved hotspots" value={`${profile?.savedCount ?? 0}`} />
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
