import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Badge } from '@ferro-maps/ui'
import { MapPin, CircleCheck, TriangleAlert, Trophy, Clock } from 'lucide-react'
import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import AppShell from '../components/AppShell'
import { BarChart, Legend } from '../components/charts'
import { getLevelProgress } from '../lib/levelThresholds'
import { formatDate } from '../lib/driverProfile'
import { share, shortDay, sumRange, useDailyStats } from '../lib/adminStats'

/** A pin a driver added: a parking bay or an egg. */
type Contribution = {
  id: string
  category?: string
  description?: string
  createdBy?: string
  confirmCount?: number
  createdAt?: Timestamp | null
  lastConfirmedAt?: Timestamp | null
}

type TopDriver = {
  uid: string
  name?: string
  xp?: number
  dayStreak?: number
  contributionScore?: number
  ferroBalance?: number
}

const STALE_DAYS = 30

function useContributions() {
  const [items, setItems] = useState<Contribution[]>([])

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'contributions'), limit(100)),
      (snap) =>
        setItems(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() }) as Contribution)
            .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)),
        ),
      (error) => console.error('contributions could not be read:', error),
    )
    return () => unsub()
  }, [])

  return items
}

/** The leaderboard, which used to be a page of its own called Driver XP. */
function useTopDrivers() {
  const [drivers, setDrivers] = useState<TopDriver[]>([])

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'users'), orderBy('xp', 'desc'), limit(10)),
      (snap) => setDrivers(snap.docs.map((d) => ({ uid: d.id, ...d.data() }) as TopDriver)),
      (error) => console.error('leaderboard could not be read:', error),
    )
    return () => unsub()
  }, [])

  return drivers
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

export default function Community() {
  const { stats: daily } = useDailyStats(30)
  const contributions = useContributions()
  const topDrivers = useTopDrivers()

  const month = sumRange(daily, 30)
  const requests = daily.reduce((sum, day) => sum + day.community.requests, 0)
  const failed = daily.reduce((sum, day) => sum + day.community.requestsFailed, 0)
  const failureRate = share(failed, requests)

  const confirmedByOthers = contributions.reduce((sum, item) => sum + Math.max(0, (item.confirmCount ?? 1) - 1), 0)
  // Measured from the last closed day rather than the browser clock, which
  // keeps the render pure and moves with the data.
  const lastDay = daily.length > 0 ? Date.parse(`${daily[daily.length - 1].dayKey}T00:00:00Z`) : 0
  const staleCutoff = lastDay - STALE_DAYS * 86_400_000
  const stale = contributions.filter(
    (item) => (item.lastConfirmedAt?.toMillis() ?? item.createdAt?.toMillis() ?? 0) < staleCutoff,
  )

  const errorCodes = daily.reduce<Record<string, number>>((acc, day) => {
    for (const [code, count] of Object.entries(day.community.errorCodes ?? {})) {
      acc[code] = (acc[code] ?? 0) + count
    }
    return acc
  }, {})

  return (
    <AppShell title="Community">
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat
            icon={<MapPin size={15} />}
            label="Pins from drivers"
            value={contributions.length.toLocaleString()}
            note={`${month.pinsCreated} added in the last 30 days`}
          />
          <Stat
            icon={<CircleCheck size={15} />}
            label="Confirmed by another driver"
            value={confirmedByOthers.toLocaleString()}
            note="times someone backed up a pin"
          />
          <Stat
            icon={<TriangleAlert size={15} />}
            label="Failed attempts"
            value={failureRate === null ? '—' : `${failureRate}%`}
            note={`${failed} of ${requests} tries in 30 days`}
          />
          <Stat
            icon={<Clock size={15} />}
            label="Not confirmed lately"
            value={stale.length.toLocaleString()}
            note={`no confirmation in ${STALE_DAYS} days`}
          />
        </div>

        <Card>
          <div className="flex items-center justify-between mb-4">
            <p className="text-label font-semibold text-text-primary">Pins added each day</p>
            <span className="text-caption text-text-tertiary">last {daily.length} days</span>
          </div>
          {daily.length > 0 ? (
            <>
              <BarChart
                height={170}
                labels={daily.map((d) => shortDay(d.dayKey))}
                seriesNames={['Pins added']}
                colors={['#D64F8A']}
                values={daily.map((d) => [d.community.pinsCreated])}
              />
              <Legend items={[{ label: 'Pins added', color: '#D64F8A' }]} />
            </>
          ) : (
            <p className="text-body-sm text-text-tertiary">No closed days yet.</p>
          )}
          {Object.keys(errorCodes).length > 0 && (
            <p className="text-caption text-text-tertiary mt-3">
              Failures by reason:{' '}
              {Object.entries(errorCodes)
                .map(([code, count]) => `${code} (${count})`)
                .join(', ')}
            </p>
          )}
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <p className="text-label font-semibold text-text-primary mb-1 flex items-center gap-2">
              <Trophy size={15} />
              Leaderboard
            </p>
            <p className="text-caption text-text-tertiary mb-4">
              XP is earned by contributing, so this is also the list of people holding the map up.
            </p>
            {topDrivers.length === 0 ? (
              <p className="text-body-sm text-text-tertiary">No drivers with XP yet.</p>
            ) : (
              <table className="w-full text-body-sm">
                <thead>
                  <tr className="text-caption uppercase tracking-wide text-text-tertiary">
                    <th className="text-left py-2 font-semibold">#</th>
                    <th className="text-left py-2 font-semibold">Driver</th>
                    <th className="text-left py-2 font-semibold">Level</th>
                    <th className="text-right py-2 font-semibold">XP</th>
                    <th className="text-right py-2 font-semibold">Streak</th>
                  </tr>
                </thead>
                <tbody>
                  {topDrivers.map((driver, index) => {
                    const progress = getLevelProgress(driver.xp ?? 0)
                    return (
                      <tr key={driver.uid} className="border-t border-border-subtle">
                        <td className="py-2 tabular-nums text-text-tertiary">{index + 1}</td>
                        <td className="py-2">
                          <Link
                            to={`/drivers/${driver.uid}`}
                            className="text-text-primary font-medium hover:text-ferro-primary"
                          >
                            {driver.name || 'Unnamed'}
                          </Link>
                        </td>
                        <td className="py-2 text-text-secondary">
                          {progress.current.level} · {progress.current.name}
                        </td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">
                          {(driver.xp ?? 0).toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums text-text-secondary">
                          {driver.dayStreak ?? 0} d
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Pins drivers have added</p>
            <p className="text-caption text-text-tertiary mb-4">
              Parking bays and eggs. Nothing clears these, so an old one nobody confirms is worth a look.
            </p>
            {contributions.length === 0 ? (
              <p className="text-body-sm text-text-tertiary">No pins yet.</p>
            ) : (
              <div className="flex flex-col">
                {contributions.slice(0, 10).map((item) => {
                  const isStale =
                    (item.lastConfirmedAt?.toMillis() ?? item.createdAt?.toMillis() ?? 0) < staleCutoff
                  return (
                    <div
                      key={item.id}
                      className="flex items-start justify-between gap-3 py-2.5 border-b border-border-subtle last:border-0"
                    >
                      <div className="min-w-0">
                        <p className="text-body-sm text-text-primary font-medium truncate">
                          {item.description ?? item.category ?? 'Pin'}
                        </p>
                        <p className="text-caption text-text-tertiary">
                          Added {formatDate(item.createdAt)} · last confirmed {formatDate(item.lastConfirmedAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-caption text-text-tertiary tabular-nums">
                          {Math.max(0, (item.confirmCount ?? 1) - 1)} confirmations
                        </span>
                        {isStale ? <Badge variant="warning">Stale</Badge> : <Badge variant="success">Fresh</Badge>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
