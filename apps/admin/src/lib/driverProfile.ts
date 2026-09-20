import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  where,
  type DocumentReference,
  type Query,
  type Timestamp,
} from 'firebase/firestore'
import { db } from './firebase'

/**
 * Everything the profile page shows about one driver.
 *
 * Queries filter on the driver and sort in the browser rather than asking
 * Firestore to order them: a uid filter plus an orderBy would need a composite
 * index for each collection, and these slices are at most fifty rows.
 */

const ROW_LIMIT = 50

export type DriverDoc = {
  uid: string
  name?: string
  email?: string
  phoneNumber?: string
  country?: string
  xp?: number
  level?: number
  ferroBalance?: number
  contributionScore?: number
  dayStreak?: number
  isOnline?: boolean
  isSuspended?: boolean
  suspendedAt?: Timestamp | null
  createdAt?: Timestamp | null
  lastActiveAt?: Timestamp | null
  locationUpdatedAt?: Timestamp | null
  subscriptionExpiresAt?: Timestamp | null
  premiumProductId?: string
  activeDeviceId?: string
  deviceClaimedAt?: Timestamp | null
}

export type Visit = {
  id: string
  hotspotId?: string
  hotspotName?: string
  category?: string
  outcome?: string
  waitMinutes?: number
  cameFromNotification?: boolean
  recordedAt?: Timestamp | null
  arrivedAt?: Timestamp | null
}

export type Alert = {
  id: string
  hotspotId?: string
  category?: string
  score?: number
  travelMinutes?: number
  estimatedJobs?: number
  sentAt?: Timestamp | null
  opened?: boolean
  actedOn?: boolean
  checked?: boolean
}

export type Contribution = {
  id: string
  category?: string
  description?: string
  confirmCount?: number
  createdAt?: Timestamp | null
  lastConfirmedAt?: Timestamp | null
}

export type AccountAction = {
  id: string
  type?: string
  status?: string
  requestedAt?: Timestamp | null
  requestedBy?: string
  error?: string
}

export type Budget = {
  notificationsToday?: number
  lastNotifiedAt?: Timestamp | null
}

export type DriverProfile = {
  visits: Visit[]
  alerts: Alert[]
  contributions: Contribution[]
  actions: AccountAction[]
  budget: Budget | null
  savedCount: number
  earningsCount: number
  deviceStatus: string | null
  subscriptionStatus: string | null
}

function millis(value: Timestamp | null | undefined): number {
  return value ? value.toMillis() : 0
}

/** Rows for a query, or none if the read is refused. */
async function fetchRows<T>(q: Query): Promise<T[]> {
  try {
    const snap = await getDocs(q)
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T)
  } catch {
    return []
  }
}

async function fetchDoc<T>(ref: DocumentReference): Promise<T | null> {
  try {
    const snap = await getDoc(ref)
    return snap.exists() ? (snap.data() as T) : null
  } catch {
    return null
  }
}

/** The driver document itself, live: suspending from this page updates in place. */
export function useDriver(uid: string | undefined) {
  const [driver, setDriver] = useState<DriverDoc | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!uid) return
    const unsub = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        setDriver(snap.exists() ? ({ uid: snap.id, ...snap.data() } as DriverDoc) : null)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return () => unsub()
  }, [uid])

  return { driver, loading }
}

/** The history around that driver, fetched once when the page opens. */
export function useDriverHistory(uid: string | undefined) {
  const [profile, setProfile] = useState<DriverProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!uid) return
    let cancelled = false

    // No setLoading(true) here: the state already starts true, and setting it
    // synchronously inside an effect is a cascading render. The page is
    // mounted per driver, so there is no stale profile to clear.
    void (async () => {
      const [visits, alerts, contributions, actions, budget, saved, earnings, device, subscription] =
        await Promise.all([
          fetchRows<Visit>(query(collection(db, 'hotspotOutcomes'), where('uid', '==', uid), limit(ROW_LIMIT))),
          fetchRows<Alert>(query(collection(db, 'notificationLog'), where('uid', '==', uid), limit(ROW_LIMIT))),
          fetchRows<Contribution>(query(collection(db, 'contributions'), where('createdBy', '==', uid), limit(ROW_LIMIT))),
          fetchRows<AccountAction>(query(collection(db, 'accountActions'), where('uid', '==', uid), limit(20))),
          fetchDoc<Budget>(doc(db, 'users', uid, 'private', 'budget')),
          fetchRows<{ id: string }>(query(collection(db, 'users', uid, 'saved_hotspots'), limit(ROW_LIMIT))),
          fetchRows<{ id: string }>(query(collection(db, 'users', uid, 'ferroEarnings'), limit(ROW_LIMIT))),
          fetchDoc<{ status?: string }>(doc(db, 'deviceSessionRequests', uid)),
          fetchDoc<{ status?: string }>(doc(db, 'subscriptionRequests', uid)),
        ])

      if (cancelled) return

      setProfile({
        visits: visits.sort((a, b) => millis(b.recordedAt ?? b.arrivedAt) - millis(a.recordedAt ?? a.arrivedAt)),
        alerts: alerts.sort((a, b) => millis(b.sentAt) - millis(a.sentAt)),
        contributions: contributions.sort((a, b) => millis(b.createdAt) - millis(a.createdAt)),
        actions: actions.sort((a, b) => millis(b.requestedAt) - millis(a.requestedAt)),
        budget,
        savedCount: saved.length,
        earningsCount: earnings.length,
        deviceStatus: device?.status ?? null,
        subscriptionStatus: subscription?.status ?? null,
      })
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [uid])

  return { profile, loading }
}

/** How a visit ended, in words a person would use. */
export const OUTCOME_LABEL: Record<string, string> = {
  job_quick: 'Job within 10 min',
  job_slow: 'Job after a wait',
  no_job: 'No job',
}

export function formatDate(value: Timestamp | null | undefined): string {
  if (!value) return '—'
  return value.toDate().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(value: Timestamp | null | undefined): string {
  if (!value) return '—'
  return value.toDate().toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
