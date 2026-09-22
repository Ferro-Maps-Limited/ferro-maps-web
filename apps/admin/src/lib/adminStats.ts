import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  type Timestamp,
} from 'firebase/firestore'
import { db } from './firebase'

// Mirrors what buildAdminLiveStats and buildAdminDailyStats write in
// functions/src/admin/stats.ts. Both documents are server-written; rules give
// this console read and nobody write.

export type QueueStats = {
  pending: number
  oldestMinutes: number | null
  capped: boolean
}

export type LiveStats = {
  builtAt: Timestamp
  dayKey: string
  drivers: { online: number; flaggedOnline: number; total: number; suspended: number; activeLast7d: number; deviceClaimed: number }
  tickets: { open: number; waitingOnUs: number; waitingOnUsOverDay: number; oldestWaitingMinutes: number | null }
  queues: Record<string, QueueStats>
  pipeline: {
    lastRunAt: Timestamp | null
    lastRunLoadId: string | null
    lastRunWritten: number | null
    lastRunFailures: string[]
    firingAlerts: string[]
  }
  heat: { windowMinutes: number; total: number; cells: { id: string; total: number; buckets: Record<string, number> }[] }
  hotspots: {
    total: number
    byCategory: Record<string, number>
    driverPins: number
    expired: number
    lastFetchedAt: Timestamp | null
    feeds: Record<string, { lastFetchedAt: Timestamp | null; sampled: number }>
    feedsCheckedAt: Timestamp | null
  }
  onlinePeak: { dayKey: string; value: number }
}

export type DailyStats = {
  dayKey: string
  drivers: { new: number; active: number; premium: number; suspended: number; deviceClaimed: number; onlinePeak: number | null }
  alerts: { sent: number; opened: number; actedOn: number; checked: number; byCategory: Record<string, { sent: number; actedOn: number }> }
  outcomes: {
    visits: number
    jobQuick: number
    jobSlow: number
    noJob: number
    fromAlert: number
    medianWaitMinutes: number | null
    byCategory: Record<string, { visits: number; jobs: number }>
  }
  community: { pinsCreated: number; requests: number; requestsFailed: number; errorCodes: Record<string, number> }
  growth: { waitlistSignups: number }
  support: { opened: number; firstReplyMedianMinutes: number | null }
  pipeline: { runs: number; written: number; failedSources: Record<string, number>; geminiCacheHits: number; geminiApiCalls: number }
}

const DAILY_PREFIX = 'daily_'

/** adminStats/live, rewritten by the rollup every few minutes. */
export function useLiveStats() {
  const [stats, setStats] = useState<LiveStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'adminStats', 'live'),
      (snap) => {
        setStats(snap.exists() ? (snap.data() as LiveStats) : null)
        setLoading(false)
      },
      (error) => {
        // Worth seeing: a denied read here means the rollup rules are wrong,
        // and the page would otherwise just look empty.
        console.error('adminStats/live could not be read:', error)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [])

  return { stats, loading }
}

/**
 * The last `days` closed days, oldest first.
 *
 * Ordered by the dayKey field rather than the document id. Firestore indexes
 * an ordinary field in both directions on its own, while sorting by document
 * id in reverse — directly or through limitToLast — asks for an index that has
 * to be created first. `live` carries a dayKey too, so it comes back with them
 * and is dropped by its id.
 */
export function useDailyStats(days = 30) {
  const [stats, setStats] = useState<DailyStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, 'adminStats'), orderBy('dayKey', 'desc'), limit(days + 1))
    const unsub = onSnapshot(
      q,
      (snap) => {
        setStats(
          snap.docs
            .filter((d) => d.id.startsWith(DAILY_PREFIX))
            .map((d) => d.data() as DailyStats)
            .reverse(),
        )
        setLoading(false)
      },
      (error) => {
        console.error('adminStats daily documents could not be read:', error)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [days])

  return { stats, loading }
}

/** Totals across a stretch of days, for the "last 7 days" style tiles. */
export function sumRange(stats: DailyStats[], days: number) {
  const window = stats.slice(-days)
  const total = {
    newDrivers: 0,
    alertsSent: 0,
    alertsOpened: 0,
    alertsActedOn: 0,
    alertsChecked: 0,
    visits: 0,
    jobs: 0,
    pinsCreated: 0,
    waitlistSignups: 0,
    ticketsOpened: 0,
  }
  for (const day of window) {
    total.newDrivers += day.drivers.new
    total.alertsSent += day.alerts.sent
    total.alertsOpened += day.alerts.opened
    total.alertsActedOn += day.alerts.actedOn
    total.alertsChecked += day.alerts.checked
    total.visits += day.outcomes.visits
    total.jobs += day.outcomes.jobQuick + day.outcomes.jobSlow
    total.pinsCreated += day.community.pinsCreated
    total.waitlistSignups += day.growth.waitlistSignups
    total.ticketsOpened += day.support.opened
  }
  return total
}

/** A percentage, or null when there is nothing to divide by. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null
}

/** "18 Sep" — the axis label for a day key. */
export function shortDay(dayKey: string): string {
  const [, month, day] = dayKey.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(day)} ${months[Number(month) - 1] ?? ''}`.trim()
}

/** Whole minutes between two server timestamps. */
export function minutesBetween(from: Timestamp, to: Timestamp): number {
  return Math.round((to.toMillis() - from.toMillis()) / 60_000)
}

/** "3 h 12 m" for a gap the reader thinks of in hours. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours} h ${rest} m` : `${hours} h`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

// Written by computeHotspotScores each night: how each hotspot worked out for
// the drivers sent to it, joined from collections no browser may read.
export type HotspotScore = {
  hotspotId: string
  name: string
  category: string
  visits: number
  jobQuick: number
  jobSlow: number
  noJob: number
  fromAlert: number
  medianWaitMinutes: number | null
  alertsSent: number
  alertsActedOn: number
}

export type HotspotScores = {
  builtAt: Timestamp
  windowDays: number
  items: HotspotScore[]
  drift: { bands: Record<string, number>; medianMetres: number | null }
  totals: { visits: number; jobs: number; alertsSent: number; alertsActedOn: number }
}

/** adminStats/hotspotScores — one document holding the whole scoreboard. */
export function useHotspotScores() {
  const [scores, setScores] = useState<HotspotScores | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'adminStats', 'hotspotScores'),
      (snap) => {
        setScores(snap.exists() ? (snap.data() as HotspotScores) : null)
        setLoading(false)
      },
      (error) => {
        console.error('hotspot scores could not be read:', error)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [])

  return { scores, loading }
}

// Written by computeAlertInsights each night: what happened to every alert,
// split by how far it asked a driver to travel, how it scored, and when it
// was sent. Rates are over `checked` alerts — ones whose window has closed.
export type AlertSplit = { sent: number; opened: number; checked: number; actedOn: number }

export type AlertInsights = {
  builtAt: Timestamp
  windowDays: number
  totals: AlertSplit
  byTravel: Record<string, AlertSplit>
  byScore: Record<string, AlertSplit>
  byHour: Record<string, AlertSplit>
  byCategory: Record<string, AlertSplit>
  visits: { fromAlert: { visits: number; jobs: number }; fromMap: { visits: number; jobs: number } }
  budget: { driversNotified: number; atCap: number }
}

/** adminStats/alertInsights — why alerts land, or do not. */
export function useAlertInsights() {
  const [insights, setInsights] = useState<AlertInsights | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'adminStats', 'alertInsights'),
      (snap) => {
        setInsights(snap.exists() ? (snap.data() as AlertInsights) : null)
        setLoading(false)
      },
      (error) => {
        console.error('alert insights could not be read:', error)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [])

  return { insights, loading }
}

// Written by computeGrowth each night. The waitlist-to-driver figure is
// matched on the server: only the counts reach the browser.
export type GrowthStats = {
  builtAt: Timestamp
  windowDays: number
  waitlist: { total: number; recent: number; converted: number; byCountry: Record<string, number> }
  drivers: { total: number; recent: number; neverReturned: number; streaks: Record<string, number> }
  premium: { active: number; byProduct: Record<string, number>; expiringSoon: number }
  churn: { deletionRequests: number; suspended: number }
}

/** adminStats/growth — sign-ups, conversion, habit and subscriptions. */
export function useGrowthStats() {
  const [growth, setGrowth] = useState<GrowthStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'adminStats', 'growth'),
      (snap) => {
        setGrowth(snap.exists() ? (snap.data() as GrowthStats) : null)
        setLoading(false)
      },
      (error) => {
        console.error('growth stats could not be read:', error)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [])

  return { growth, loading }
}
