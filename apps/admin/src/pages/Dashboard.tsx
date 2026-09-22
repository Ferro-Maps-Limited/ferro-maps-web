import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card, Badge } from '@ferro-maps/ui'
import {
  Car,
  UserPlus,
  Send,
  CircleCheck,
  MessageSquare,
  Users,
  TriangleAlert,
  CircleAlert,
  Info,
  Clock,
} from 'lucide-react'
import { collection, query, orderBy, limit, onSnapshot, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import AppShell from '../components/AppShell'
import DensityMap from '../components/DensityMap'
import { useMapData } from '../lib/mapData'
import { BarChart, LineChart, Legend, Sparkline } from '../components/charts'
import { OUTCOME_COLOR } from '../lib/chartColors'
import {
  formatMinutes,
  share,
  shortDay,
  sumRange,
  useDailyStats,
  useLiveStats,
  type LiveStats,
} from '../lib/adminStats'

interface RecentTicket {
  id: string
  email: string
  message: string
  status: string
  submittedAt: Timestamp | null
}

type Attention = {
  severity: 'danger' | 'warning' | 'info'
  title: string
  detail: string
}

function emailInitials(email: string): string {
  return email.split('@')[0].slice(0, 2).toUpperCase()
}

function Stat({
  icon,
  label,
  value,
  note,
  trend,
}: {
  icon: ReactNode
  label: string
  value: string
  note?: string
  trend?: number[]
}) {
  return (
    <Card className="!p-4">
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-body-sm text-text-secondary">
          {icon}
          {label}
        </span>
        <div className="flex items-end justify-between gap-2">
          <span className="text-2xl font-bold tabular-nums leading-tight text-text-primary">{value}</span>
          {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
        </div>
        {note ? <span className="text-caption text-text-tertiary">{note}</span> : null}
      </div>
    </Card>
  )
}

const SEVERITY_STYLES = {
  danger: { border: 'border-status-danger', icon: <CircleAlert size={16} className="text-status-danger" /> },
  warning: { border: 'border-status-warning', icon: <TriangleAlert size={16} className="text-status-warning" /> },
  info: { border: 'border-status-info', icon: <Info size={16} className="text-status-info" /> },
} as const

/**
 * What the live rollup says is wrong right now.
 *
 * Only things somebody can act on today, most serious first — this is what the
 * bell icon in the header should have been pointing at all along.
 */
function attentionItems(live: LiveStats | null): Attention[] {
  if (!live) return []
  const items: Attention[] = []

  for (const alert of live.pipeline.firingAlerts) {
    items.push({
      severity: 'danger',
      title: `Demand pipeline alert: ${alert.replace(/_/g, ' ')}`,
      detail: 'New hotspots stop reaching the map while this is firing.',
    })
  }

  if (live.tickets.waitingOnUsOverDay > 0) {
    items.push({
      severity: 'warning',
      title: `${live.tickets.waitingOnUsOverDay} ticket${live.tickets.waitingOnUsOverDay === 1 ? '' : 's'} waiting on us for over 24 hours`,
      detail: `Oldest has waited ${formatMinutes(live.tickets.oldestWaitingMinutes)} since the driver last wrote.`,
    })
  }

  for (const [name, queue] of Object.entries(live.queues ?? {})) {
    if (queue.oldestMinutes !== null && queue.oldestMinutes > 30) {
      items.push({
        severity: 'warning',
        title: `${queue.pending} request${queue.pending === 1 ? '' : 's'} stuck in ${name}`,
        detail: `Oldest has waited ${formatMinutes(queue.oldestMinutes)}. The trigger that answers them may have stopped.`,
      })
    }
  }

  // users.isOnline is set by the apps and not reliably cleared, so it drifts
  // upwards. The tile above counts fresh positions instead; this says so when
  // the two have come far apart.
  if (live.drivers.flaggedOnline > Math.max(50, live.drivers.online * 3)) {
    items.push({
      severity: 'warning',
      title: `${live.drivers.flaggedOnline.toLocaleString()} accounts still say they are online`,
      detail: `Only ${live.drivers.online.toLocaleString()} have sent a recent position. The apps leave the online flag set when they are killed rather than signed out.`,
    })
  }

  // The rules let pre-update app builds keep writing until 15 Oct 2026. After
  // that a driver who never claimed a device session cannot go online at all.
  const claimShare = share(live.drivers.deviceClaimed, live.drivers.total)
  if (claimShare !== null && claimShare < 95) {
    items.push({
      severity: 'warning',
      title: `${100 - claimShare}% of active drivers are still on the old app build`,
      detail: 'They lose the ability to go online when the grace period ends on 15 October 2026.',
    })
  }

  if (items.length === 0) {
    items.push({
      severity: 'info',
      title: 'Nothing needs attention',
      detail: 'No pipeline alerts, no stuck requests, no tickets older than a day.',
    })
  }

  return items
}

/** The Overview's map is a preview: density and hotspots, no driver pins. */
const MAP_LAYERS = { density: true, hotspots: true, driverPins: false }

export default function Dashboard() {
  const { cells, pins } = useMapData(MAP_LAYERS)
  const { stats: live, loading: liveLoading } = useLiveStats()
  const { stats: daily, loading: dailyLoading } = useDailyStats(30)
  const [recentTickets, setRecentTickets] = useState<RecentTicket[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(true)

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'supportRequests'), orderBy('submittedAt', 'desc'), limit(3)),
      (snap) => {
        setRecentTickets(
          snap.docs.map((d) => ({
            id: d.id,
            email: d.data().email ?? '',
            message: d.data().message ?? '',
            status: d.data().status ?? 'open',
            submittedAt: d.data().submittedAt ?? null,
          })),
        )
        setTicketsLoading(false)
      },
    )
    return () => unsub()
  }, [])

  const week = sumRange(daily, 7)
  const previousWeek = sumRange(daily.slice(0, -7), 7)
  const labels = daily.map((d) => shortDay(d.dayKey))
  const last14 = daily.slice(-14)

  const actedOnShare = share(week.alertsActedOn, week.alertsChecked)
  const previousActedOn = share(previousWeek.alertsActedOn, previousWeek.alertsChecked)
  const jobShare = share(week.jobs, week.visits)

  const waitingOnRollup = !liveLoading && !dailyLoading && live === null && daily.length === 0

  return (
    <AppShell title="Overview">
      <div className="flex flex-col gap-6">
        {waitingOnRollup && (
          <Card className="bg-amber-50">
            <p className="text-label font-semibold text-text-primary mb-1">No figures yet</p>
            <p className="text-body-sm text-text-secondary">
              The counting job has not written anything yet. Once it is deployed it refreshes the live numbers every
              five minutes, closes each day after midnight, and the backfill fills in the history.
            </p>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <Stat
            icon={<Car size={15} />}
            label="Drivers online"
            value={live ? live.drivers.online.toLocaleString() : '—'}
            note={
              live
                ? `Seen in the last ${live.heat?.windowMinutes ?? 5} min · peak today ${live.onlinePeak.value}`
                : 'Waiting for the live count'
            }
          />
          <Stat
            icon={<Users size={15} />}
            label="Active yesterday"
            value={daily.length ? daily[daily.length - 1].drivers.active.toLocaleString() : '—'}
            note={live ? `${live.drivers.total.toLocaleString()} drivers in total` : undefined}
            trend={daily.map((d) => d.drivers.active)}
          />
          <Stat
            icon={<UserPlus size={15} />}
            label="New drivers (7 days)"
            value={week.newDrivers.toLocaleString()}
            note={`${previousWeek.newDrivers.toLocaleString()} the week before`}
            trend={daily.map((d) => d.drivers.new)}
          />
          <Stat
            icon={<Send size={15} />}
            label="Alerts acted on"
            value={actedOnShare === null ? '—' : `${actedOnShare}%`}
            note={
              previousActedOn === null
                ? `${week.alertsSent.toLocaleString()} alerts sent this week`
                : `${previousActedOn}% the week before`
            }
          />
          <Stat
            icon={<CircleCheck size={15} />}
            label="Visits that found a job"
            value={jobShare === null ? '—' : `${jobShare}%`}
            note={`${week.visits.toLocaleString()} visits in 7 days`}
          />
          <Stat
            icon={<MessageSquare size={15} />}
            label="Waiting on us"
            value={live ? live.tickets.waitingOnUs.toLocaleString() : '—'}
            note={live ? `${live.tickets.open.toLocaleString()} tickets open in total` : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3">
            <Card className="h-full">
              <div className="flex items-center justify-between mb-4">
                <p className="text-label font-semibold text-text-primary">Drivers active each day</p>
                <span className="text-caption text-text-tertiary">last {daily.length} days</span>
              </div>
              {daily.length > 1 ? (
                <>
                  <LineChart
                    labels={labels}
                    series={[
                      { label: 'Active drivers', values: daily.map((d) => d.drivers.active), color: '#0E9BF7' },
                      { label: 'New drivers', values: daily.map((d) => d.drivers.new), color: '#1A2A4A', dashed: true },
                    ]}
                  />
                  <Legend
                    items={[
                      { label: 'Active drivers', color: '#0E9BF7' },
                      { label: 'New drivers', color: '#1A2A4A' },
                    ]}
                  />
                </>
              ) : (
                <p className="text-body-sm text-text-tertiary">Needs at least two closed days.</p>
              )}
            </Card>
          </div>

          <div className="lg:col-span-2">
            <Card className="h-full">
              <p className="text-label font-semibold text-text-primary mb-4">Needs attention</p>
              <div className="flex flex-col gap-2">
                {liveLoading ? (
                  <div className="h-16 bg-surface-raised animate-pulse rounded-md" />
                ) : (
                  attentionItems(live).map((item) => (
                    <div
                      key={item.title}
                      className={`flex gap-3 rounded-md bg-surface-raised border-l-[3px] p-3 ${SEVERITY_STYLES[item.severity].border}`}
                    >
                      <span className="mt-0.5">{SEVERITY_STYLES[item.severity].icon}</span>
                      <div className="min-w-0">
                        <p className="text-body-sm font-semibold text-text-primary">{item.title}</p>
                        <p className="text-caption text-text-secondary">{item.detail}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card>
            <div className="flex items-center justify-between mb-4">
              <p className="text-label font-semibold text-text-primary">What visits led to</p>
              <span className="text-caption text-text-tertiary">last {last14.length} days</span>
            </div>
            {last14.length > 0 ? (
              <>
                <BarChart
                  height={180}
                  labels={last14.map((d) => shortDay(d.dayKey))}
                  seriesNames={['Job within 10 min', 'Job after a wait', 'No job']}
                  colors={[OUTCOME_COLOR.jobQuick, OUTCOME_COLOR.jobSlow, OUTCOME_COLOR.noJob]}
                  values={last14.map((d) => [d.outcomes.jobQuick, d.outcomes.jobSlow, d.outcomes.noJob])}
                />
                <Legend
                  items={[
                    { label: 'Job within 10 min', color: OUTCOME_COLOR.jobQuick },
                    { label: 'Job after a wait', color: OUTCOME_COLOR.jobSlow },
                    { label: 'No job', color: OUTCOME_COLOR.noJob },
                  ]}
                />
              </>
            ) : (
              <p className="text-body-sm text-text-tertiary">No closed days yet.</p>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-4">
              <p className="text-label font-semibold text-text-primary">Where drivers are</p>
              <Link to="/map" className="text-caption text-ferro-primary font-semibold">
                Open the map
              </Link>
            </div>
            <DensityMap
              className="h-64 rounded-md overflow-hidden"
              layers={MAP_LAYERS}
              cells={cells}
              pins={pins}
              driverPins={[]}
            />
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-4">
              <p className="text-label font-semibold text-text-primary">Latest tickets</p>
              {live && live.tickets.oldestWaitingMinutes !== null && (
                <span className="inline-flex items-center gap-1 text-caption text-text-tertiary">
                  <Clock size={12} />
                  waiting {formatMinutes(live.tickets.oldestWaitingMinutes)}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-4">
              {ticketsLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-neutral-200 animate-pulse flex-shrink-0" />
                    <div className="flex-1 flex flex-col gap-1.5 pt-1">
                      <div className="h-3 w-32 bg-neutral-200 animate-pulse rounded" />
                      <div className="h-2.5 w-full bg-neutral-200 animate-pulse rounded" />
                    </div>
                  </div>
                ))
              ) : recentTickets.length === 0 ? (
                <p className="text-body-sm text-text-tertiary">No tickets yet</p>
              ) : (
                recentTickets.map((ticket) => (
                  <div key={ticket.id} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-caption font-semibold text-text-secondary">
                        {emailInitials(ticket.email)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-label font-medium text-text-primary truncate">{ticket.email}</p>
                        <Badge variant={ticket.status === 'open' ? 'success' : 'error'}>
                          {ticket.status === 'open' ? 'Open' : 'Closed'}
                        </Badge>
                      </div>
                      <p className="text-body-sm text-text-secondary truncate">
                        {ticket.message.slice(0, 60)}
                        {ticket.message.length > 60 ? '…' : ''}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
