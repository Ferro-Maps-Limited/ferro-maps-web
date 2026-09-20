import { useMemo } from 'react'
import { Card } from '@ferro-maps/ui'
import { ListChecks, UserPlus, Crown, UserMinus, Flame } from 'lucide-react'
import AppShell from '../components/AppShell'
import { LineChart, Legend } from '../components/charts'
import { share, shortDay, useDailyStats, useGrowthStats } from '../lib/adminStats'

/** Streak buckets in the order a habit builds, not alphabetical. */
const STREAK_ORDER = ['none', '1-2 days', '3-6 days', '1-2 weeks', '2-4 weeks', 'a month or more']

function Stat({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode
  label: string
  value: string
  note?: string
}) {
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

function Bar({ label, value, busiest, note }: { label: string; value: number; busiest: number; note?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 flex-shrink-0 text-body-sm text-text-secondary">{label}</span>
      <div className="flex-1 h-2.5 bg-surface-sunken rounded-full overflow-hidden">
        <div
          className="h-full bg-ferro-primary rounded-full"
          style={{ width: `${(value / Math.max(busiest, 1)) * 100}%` }}
        />
      </div>
      <span className="w-20 text-right text-body-sm font-semibold tabular-nums text-text-primary">
        {value.toLocaleString()}
      </span>
      {note && <span className="w-12 text-right text-caption text-text-tertiary tabular-nums">{note}</span>}
    </div>
  )
}

export default function Growth() {
  const { growth, loading } = useGrowthStats()
  const { stats: daily } = useDailyStats(30)

  const countries = useMemo(
    () => Object.entries(growth?.waitlist.byCountry ?? {}).sort((a, b) => b[1] - a[1]),
    [growth],
  )
  const streaks = useMemo(
    () =>
      STREAK_ORDER.map((bucket) => ({ bucket, count: growth?.drivers.streaks[bucket] ?? 0 })).filter(
        (entry) => entry.count > 0,
      ),
    [growth],
  )

  const conversion = growth ? share(growth.waitlist.converted, growth.waitlist.total) : null
  const returnedShare = growth ? share(growth.drivers.total - growth.drivers.neverReturned, growth.drivers.total) : null

  return (
    <AppShell title="Growth">
      <div className="flex flex-col gap-6">
        {!loading && !growth && (
          <Card className="bg-amber-50">
            <p className="text-label font-semibold text-text-primary mb-1">Nothing counted yet</p>
            <p className="text-body-sm text-text-secondary">
              Sign-ups and subscriptions are counted each night. This fills in after the next run.
            </p>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat
            icon={<UserPlus size={15} />}
            label="Drivers"
            value={growth ? growth.drivers.total.toLocaleString() : '—'}
            note={growth ? `${growth.drivers.recent} joined in ${growth.windowDays} days` : undefined}
          />
          <Stat
            icon={<ListChecks size={15} />}
            label="On the waitlist"
            value={growth ? growth.waitlist.total.toLocaleString() : '—'}
            note={growth ? `${growth.waitlist.recent} added in ${growth.windowDays} days` : undefined}
          />
          <Stat
            icon={<UserPlus size={15} />}
            label="Waitlist became drivers"
            value={conversion === null ? '—' : `${conversion}%`}
            note={growth ? `${growth.waitlist.converted} of ${growth.waitlist.total}, matched by email` : undefined}
          />
          <Stat
            icon={<Crown size={15} />}
            label="Premium subscribers"
            value={growth ? growth.premium.active.toLocaleString() : '—'}
            note={
              growth && growth.premium.active > 0
                ? `${growth.premium.expiringSoon} expiring within a week`
                : 'None yet'
            }
          />
        </div>

        <Card>
          <div className="flex items-center justify-between mb-4">
            <p className="text-label font-semibold text-text-primary">Drivers joining each day</p>
            <span className="text-caption text-text-tertiary">last {daily.length} days</span>
          </div>
          {daily.length > 1 ? (
            <>
              <LineChart
                labels={daily.map((d) => shortDay(d.dayKey))}
                series={[
                  { label: 'New drivers', values: daily.map((d) => d.drivers.new), color: '#0E9BF7' },
                  {
                    label: 'Waitlist sign-ups',
                    values: daily.map((d) => d.growth.waitlistSignups),
                    color: '#1A2A4A',
                    dashed: true,
                  },
                ]}
              />
              <Legend
                items={[
                  { label: 'New drivers', color: '#0E9BF7' },
                  { label: 'Waitlist sign-ups', color: '#1A2A4A' },
                ]}
              />
            </>
          ) : (
            <p className="text-body-sm text-text-tertiary">Needs at least two closed days.</p>
          )}
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Do they come back</p>
            <p className="text-caption text-text-tertiary mb-4">
              How long a driver&rsquo;s current run of consecutive active days is.
            </p>
            {streaks.length === 0 ? (
              <p className="text-body-sm text-text-tertiary">No streaks recorded yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {streaks.map((entry) => (
                  <Bar
                    key={entry.bucket}
                    label={entry.bucket}
                    value={entry.count}
                    busiest={Math.max(...streaks.map((s) => s.count))}
                  />
                ))}
              </div>
            )}
            {growth && (
              <div className="mt-4 rounded-md bg-surface-raised p-3">
                <p className="text-body-sm text-text-primary font-semibold">
                  {growth.drivers.neverReturned.toLocaleString()} drivers never came back after the day they joined
                </p>
                <p className="text-caption text-text-secondary">
                  That is {100 - (returnedShare ?? 0)}% of everyone who has signed up. The rest returned at least once.
                </p>
              </div>
            )}
          </Card>

          <Card>
            <p className="text-label font-semibold text-text-primary mb-1">Where the waitlist is</p>
            <p className="text-caption text-text-tertiary mb-4">Countries people gave when signing up.</p>
            {countries.length === 0 ? (
              <p className="text-body-sm text-text-tertiary">Nothing yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {countries.slice(0, 8).map(([country, count]) => (
                  <Bar
                    key={country}
                    label={country}
                    value={count}
                    busiest={countries[0][1]}
                    note={`${share(count, growth?.waitlist.total ?? 1)}%`}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <p className="text-label font-semibold text-text-primary mb-3 flex items-center gap-2">
              <Crown size={15} />
              Premium
            </p>
            {growth && growth.premium.active > 0 ? (
              <div className="flex flex-col gap-3">
                {Object.entries(growth.premium.byProduct).map(([product, count]) => (
                  <Bar
                    key={product}
                    label={product.split('.').pop() ?? product}
                    value={count}
                    busiest={growth.premium.active}
                  />
                ))}
                <p className="text-caption text-text-tertiary">
                  {growth.premium.expiringSoon} subscription{growth.premium.expiringSoon === 1 ? '' : 's'} expire within
                  a week.
                </p>
              </div>
            ) : (
              <div className="rounded-md bg-surface-raised p-4">
                <p className="text-body-sm text-text-secondary">
                  Nobody is subscribed yet. Premium is granted only when Apple confirms a purchase, so this counts real
                  paying drivers and will stay at zero until the first one comes through.
                </p>
              </div>
            )}
          </Card>

          <Card>
            <p className="text-label font-semibold text-text-primary mb-3 flex items-center gap-2">
              <UserMinus size={15} />
              Leaving
            </p>
            <div className="flex flex-col">
              <div className="flex justify-between py-2 border-b border-border-subtle">
                <span className="text-body-sm text-text-tertiary">
                  Asked to delete their account ({growth?.windowDays ?? 30} days)
                </span>
                <span className="text-body-sm font-semibold text-text-primary tabular-nums">
                  {growth?.churn.deletionRequests ?? 0}
                </span>
              </div>
              <div className="flex justify-between py-2 border-b border-border-subtle">
                <span className="text-body-sm text-text-tertiary">Suspended by an admin</span>
                <span className="text-body-sm font-semibold text-text-primary tabular-nums">
                  {growth?.churn.suspended ?? 0}
                </span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-body-sm text-text-tertiary">
                  <Flame size={13} className="inline mr-1.5 -mt-0.5" />
                  Drivers with a week-long streak or better
                </span>
                <span className="text-body-sm font-semibold text-text-primary tabular-nums">
                  {(growth?.drivers.streaks['1-2 weeks'] ?? 0) +
                    (growth?.drivers.streaks['2-4 weeks'] ?? 0) +
                    (growth?.drivers.streaks['a month or more'] ?? 0)}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
