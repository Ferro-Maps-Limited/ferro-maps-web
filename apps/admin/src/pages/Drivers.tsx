import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import {
  collection,
  query,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  GeoPoint,
  Timestamp,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore'
import { MoreHorizontal, ChevronUp, ChevronDown } from 'lucide-react'
import { Input, Badge } from '@ferro-maps/ui'
import { db } from '../lib/firebase'
import { submitAccountAction } from '../lib/accountActions'
import AppShell from '../components/AppShell'
import { useDriverFilters } from '../hooks/useDriverFilters'
import type { ZoneFilter } from '../hooks/useDriverFilters'

interface DriverDoc {
  uid: string
  name: string
  email: string
  phoneNumber: string
  isOnline: boolean
  ferroBalance: number
  country: string
  isSuspended: boolean
  lat?: number
  lng?: number
  joinedAt: Timestamp | null
  suspendedAt: Timestamp | null
}

const PAGE_SIZE = 10

const ZONE_OPTIONS: ZoneFilter[] = ['all', 'Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5', 'Zone 6']

const AVATAR_COLORS = [
  'bg-violet-500',
  'bg-blue-500',
  'bg-green-600',
  'bg-orange-500',
  'bg-pink-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-red-500',
]

function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length]
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function formatBalance(n: number): string {
  return n.toLocaleString() + ' F'
}

const COLUMNS: { label: string; sortKey: string | null }[] = [
  { label: 'Driver', sortKey: 'name' },
  { label: 'Status', sortKey: null },
  { label: 'Country', sortKey: 'country' },
  { label: 'Joined', sortKey: null },
  { label: 'Balance', sortKey: 'ferroBalance' },
  { label: 'Phone', sortKey: null },
  { label: 'Actions', sortKey: null },
]

export default function Drivers() {
  const [drivers, setDrivers] = useState<DriverDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const [suspendingUid, setSuspendingUid] = useState<string | null>(null)
  const [deletingUid, setDeletingUid] = useState<string | null>(null)
  const [openMenuUid, setOpenMenuUid] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [sortColumn, setSortColumn] = useState('name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  // useRef avoids stale closures when reading cursors inside the effect while
  // keeping pageCursors out of the effect's dependency array (adding it would
  // re-trigger the listener every time a new cursor is stored).
  const pageCursors = useRef<QueryDocumentSnapshot<DocumentData>[]>([])
  const [hasNextPage, setHasNextPage] = useState(false)

  const { statusFilter, setStatusFilter, zoneFilter, setZoneFilter, filteredDrivers } =
    useDriverFilters(drivers)

  useEffect(() => {
    const cursor = currentPage > 1 ? pageCursors.current[currentPage - 2] : undefined
    const q = cursor
      ? query(
          collection(db, 'users'),
          orderBy(sortColumn, sortDirection),
          startAfter(cursor),
          limit(PAGE_SIZE),
        )
      : query(collection(db, 'users'), orderBy(sortColumn, sortDirection), limit(PAGE_SIZE))

    const unsub = onSnapshot(q, (snapshot) => {
      const list: DriverDoc[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data()
        return {
          uid: d.uid ?? docSnap.id,
          name: d.name ?? '',
          email: d.email ?? '',
          phoneNumber: d.phoneNumber ?? '',
          isOnline: d.isOnline ?? false,
          ferroBalance: typeof d.ferroBalance === 'number' ? d.ferroBalance : 0,
          country: d.country ?? '',
          isSuspended: d.isSuspended ?? false,
          lat: d.location instanceof GeoPoint ? d.location.latitude : undefined,
          lng: d.location instanceof GeoPoint ? d.location.longitude : undefined,
          joinedAt:
            d.joinedAt instanceof Timestamp
              ? d.joinedAt
              : d.createdAt instanceof Timestamp
                ? d.createdAt
                : null,
          suspendedAt: d.suspendedAt instanceof Timestamp ? d.suspendedAt : null,
        }
      })
      setDrivers(list)
      setLoading(false)
      if (snapshot.docs.length > 0) {
        pageCursors.current[currentPage - 1] = snapshot.docs[snapshot.docs.length - 1]
      }
      setHasNextPage(snapshot.docs.length === PAGE_SIZE)
    })
    return () => unsub()
  }, [currentPage, sortColumn, sortDirection, refreshTick])

  useEffect(() => {
    if (!openMenuUid) return
    const close = () => {
      setOpenMenuUid(null)
      setMenuPosition(null)
    }
    document.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [openMenuUid])

  const filtered = filteredDrivers.filter((d) => {
    const q = search.toLowerCase()
    return (
      !q ||
      d.name.toLowerCase().includes(q) ||
      d.email.toLowerCase().includes(q) ||
      d.phoneNumber.includes(q)
    )
  })

  function handleSort(key: string) {
    setLoading(true)
    if (sortColumn === key) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(key)
      setSortDirection('asc')
    }
    setCurrentPage(1)
    pageCursors.current = []
  }

  async function handleSuspendToggle(driver: DriverDoc) {
    setSuspendingUid(driver.uid)
    try {
      await submitAccountAction(driver.isSuspended ? 'unsuspend' : 'suspend', driver.uid)
      setRefreshTick((t) => t + 1)
    } catch (error) {
      console.error('Failed to update account status:', error)
      alert('Could not update this account. Please try again.')
    } finally {
      setSuspendingUid(null)
      setOpenMenuUid(null)
    }
  }

  async function handleDeleteAccount(driver: DriverDoc) {
    setOpenMenuUid(null)
    setMenuPosition(null)

    const confirmed = window.confirm(
      `Permanently delete ${driver.name}'s account?\n\n` +
        'This removes their Firebase login, profile data, and earnings history. ' +
        'This cannot be undone.',
    )
    if (!confirmed) return

    setDeletingUid(driver.uid)
    try {
      await submitAccountAction('delete', driver.uid)
      setRefreshTick((t) => t + 1)
    } catch (error) {
      console.error('Failed to delete account:', error)
      alert('Could not delete this account. Please try again.')
    } finally {
      setDeletingUid(null)
    }
  }

  return (
    <AppShell title="Drivers">
      <div className="flex flex-col gap-4">
        {/* Search + filter bar */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 max-w-sm">
            <Input
              placeholder="Search by name, email or phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="px-3 py-2 text-sm rounded-button border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-ferro-primary focus:ring-offset-2"
          >
            {(['all', 'online', 'offline', 'suspended'] as const).map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <select
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value as ZoneFilter)}
            className="px-3 py-2 text-sm rounded-button border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-ferro-primary focus:ring-offset-2"
          >
            {ZONE_OPTIONS.map((z) => (
              <option key={z} value={z}>
                {z === 'all' ? 'All Zones' : z}
              </option>
            ))}
          </select>
          <p className="text-sm text-text-secondary whitespace-nowrap">
            {loading
              ? 'Loading…'
              : `Showing ${filtered.length} of ${drivers.length} drivers`}
          </p>
        </div>
        <p className="text-xs text-text-tertiary -mt-2">
          Search and filters apply to the current page only
        </p>

        {/* Table card */}
        <div className="bg-white rounded-card border border-gray-200 shadow-md overflow-hidden">
          <p className="md:hidden text-xs text-gray-400 px-4 pt-3">Swipe to see more</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-neutral-50">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.label}
                      className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wide"
                    >
                      {col.sortKey ? (
                        <button
                          onClick={() => handleSort(col.sortKey!)}
                          className="flex items-center gap-1 hover:text-text-primary transition-colors"
                        >
                          {col.label}
                          {sortColumn === col.sortKey &&
                            (sortDirection === 'asc' ? (
                              <ChevronUp size={12} />
                            ) : (
                              <ChevronDown size={12} />
                            ))}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="border-b border-gray-200 last:border-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-neutral-200 animate-pulse flex-shrink-0" />
                          <div className="flex flex-col gap-1.5">
                            <div className="h-3 w-28 bg-neutral-200 animate-pulse rounded" />
                            <div className="h-2.5 w-20 bg-neutral-200 animate-pulse rounded" />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-5 w-16 bg-neutral-200 animate-pulse rounded-full" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-3 w-12 bg-neutral-200 animate-pulse rounded" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-3 w-20 bg-neutral-200 animate-pulse rounded" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-3 w-20 bg-neutral-200 animate-pulse rounded" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-3 w-24 bg-neutral-200 animate-pulse rounded" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-8 w-8 bg-neutral-200 animate-pulse rounded" />
                      </td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="py-16 text-center text-text-secondary">No drivers found</div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((driver) => (
                    <tr
                      key={driver.uid}
                      className="border-b border-gray-200 last:border-0 hover:bg-neutral-50 cursor-pointer"
                      onClick={() => navigate(`/drivers/${driver.uid}`)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor(driver.name)}`}
                          >
                            <span className="text-white text-xs font-semibold">
                              {getInitials(driver.name)}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-text-primary truncate">{driver.name}</p>
                            <p className="text-xs text-text-tertiary truncate">{driver.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {driver.isSuspended ? (
                          <Badge variant="error">Suspended</Badge>
                        ) : driver.isOnline ? (
                          <Badge variant="success">Online</Badge>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">
                            Offline
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{driver.country || '—'}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {driver.joinedAt ? driver.joinedAt.toDate().toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">
                        {formatBalance(driver.ferroBalance)}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">
                        {driver.phoneNumber || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (openMenuUid === driver.uid) {
                                setOpenMenuUid(null)
                                setMenuPosition(null)
                              } else {
                                const rect = e.currentTarget.getBoundingClientRect()
                                setMenuPosition({
                                  top: rect.bottom + 4,
                                  left: rect.right - 144,
                                })
                                setOpenMenuUid(driver.uid)
                              }
                            }}
                            className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-neutral-100 transition-colors"
                            aria-label="Driver actions"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                          {openMenuUid === driver.uid &&
                            menuPosition &&
                            createPortal(
                              <div
                                onClick={(e) => e.stopPropagation()}
                                style={{ top: menuPosition.top, left: menuPosition.left }}
                                className="fixed z-50 w-36 bg-white border border-gray-200 rounded-card shadow-md py-1"
                              >
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleSuspendToggle(driver)
                                  }}
                                  disabled={suspendingUid === driver.uid}
                                  className="w-full text-left px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50 transition-colors"
                                >
                                  {suspendingUid === driver.uid
                                    ? 'Updating…'
                                    : driver.isSuspended
                                      ? 'Enable account'
                                      : 'Disable account'}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeleteAccount(driver)
                                  }}
                                  disabled={deletingUid === driver.uid}
                                  className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                                >
                                  {deletingUid === driver.uid ? 'Deleting…' : 'Delete account'}
                                </button>
                              </div>,
                              document.body,
                            )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination footer */}
          <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between text-sm text-text-secondary">
            <span>
              Showing page {currentPage}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setLoading(true); setCurrentPage((p) => p - 1) }}
                disabled={currentPage === 1}
                className="px-3 py-1.5 rounded-button border border-gray-300 text-sm disabled:opacity-40 hover:bg-neutral-50 transition-colors disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => { setLoading(true); setCurrentPage((p) => p + 1) }}
                disabled={!hasNextPage}
                className="px-3 py-1.5 rounded-button border border-gray-300 text-sm disabled:opacity-40 hover:bg-neutral-50 transition-colors disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
