import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { LayoutDashboard, Map, Car, Flame, Send, TrendingUp, Users, MessageSquare, Settings, ChevronLeft, ChevronRight, ListChecks, Menu, LogOut, Activity } from 'lucide-react'
import { collection, query, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { isTicketUnread, type UnreadTicket } from '../lib/utils'
import { ROLE_LABEL, type StaffRole } from '../lib/roles'
import ferroBirdIcon from '../assets/ferro-bird-icon.png'

type AppShellProps = {
  children: ReactNode
  title: string
  unreadCount?: number
}

function getInitials(email: string | null | undefined): string {
  if (!email) return '?'
  const local = email.split('@')[0].toUpperCase()
  const parts = local.split(/[.\-_]/).filter(Boolean)
  return parts.map((p) => p[0]).join('').slice(0, 2) || local.slice(0, 2)
}

export default function AppShell({ children, title }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  // The mobile drawer always shows the full (uncollapsed) sidebar, regardless
  // of the desktop collapse state, since collapsing only makes sense for the
  // docked desktop layout.
  const effectiveCollapsed = mobileOpen ? false : collapsed

  useEffect(() => {
    const q = query(collection(db, 'supportRequests'))
    const unsub = onSnapshot(q, (snap) => {
      const count = snap.docs.filter((d) => isTicketUnread(d.data() as UnreadTicket)).length
      setUnreadCount(count)
    })
    return () => unsub()
  }, [])
  const { user, role, signOut } = useAuth()
  const initials = getInitials(user?.email)

  // Three groups, because twelve destinations in one list stops being a list.
  // Operate is what you do today, Analyse is what you learn from it, Platform
  // is the machinery. `roles` must match the allow list on each page's
  // ProtectedRoute in App.tsx.
  type NavItem = { label: string; to: string; icon: ReactNode; badge?: number; roles: StaffRole[] }
  const allGroups: { heading: string; items: NavItem[] }[] = [
    {
      heading: 'Operate',
      items: [
        { label: 'Overview', to: '/dashboard', icon: <LayoutDashboard size={20} />, roles: ['admin'] },
        { label: 'Live map', to: '/map', icon: <Map size={20} />, roles: ['admin'] },
        { label: 'Drivers', to: '/drivers', icon: <Car size={20} />, roles: ['admin'] },
        {
          label: 'Support',
          to: '/messages',
          icon: <MessageSquare size={20} />,
          badge: unreadCount,
          roles: ['admin', 'support'],
        },
      ],
    },
    {
      heading: 'Analyse',
      items: [
        { label: 'Hotspots', to: '/hotspots', icon: <Flame size={20} />, roles: ['admin'] },
        { label: 'Engagement', to: '/engagement', icon: <Send size={20} />, roles: ['admin'] },
        { label: 'Community', to: '/community', icon: <Users size={20} />, roles: ['admin'] },
        { label: 'Growth', to: '/growth', icon: <TrendingUp size={20} />, roles: ['admin'] },
      ],
    },
    {
      heading: 'Platform',
      items: [
        { label: 'Waitlist', to: '/waitlist', icon: <ListChecks size={20} />, roles: ['admin'] },
        { label: 'System health', to: '/system', icon: <Activity size={20} />, roles: ['admin'] },
        { label: 'Settings', to: '/settings', icon: <Settings size={20} />, roles: ['admin'] },
      ],
    },
  ]

  const navGroups = allGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => role !== null && item.roles.includes(role)),
    }))
    .filter((group) => group.items.length > 0)

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile scrim */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-ferro-deep transition-[width,transform] duration-base ease-standard flex-shrink-0 fixed inset-y-0 left-0 z-50 md:static md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } ${effectiveCollapsed ? 'w-[72px]' : 'w-[220px]'}`}
      >
        {/* Logo + toggle */}
        <div
          className={`flex items-center py-5 ${
            effectiveCollapsed ? 'px-2 justify-between' : 'px-4 gap-3'
          }`}
        >
          <img
            src={ferroBirdIcon}
            alt="Ferro Maps"
            className="w-8 h-8 rounded-md flex-shrink-0"
          />
          {!effectiveCollapsed && (
            <span className="text-white font-medium text-label truncate flex-1">Ferro Maps</span>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="hidden md:flex w-5 h-5 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors duration-fast flex-shrink-0"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col gap-1 px-2 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.heading} className="flex flex-col gap-1">
              {!effectiveCollapsed && (
                <p className="px-3 pt-4 pb-1 text-overline font-bold uppercase tracking-wider text-white/45">
                  {group.heading}
                </p>
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => {
                    const base = 'flex items-center rounded-md transition-colors duration-fast text-label'
                    const layout = effectiveCollapsed ? 'justify-center py-2 px-2' : 'gap-3 px-3 py-2'
                    const color = isActive
                      ? 'bg-white/15 text-white'
                      : 'text-white/75 hover:bg-white/10 hover:text-white'
                    return `${base} ${layout} ${color}`
                  }}
                >
                  <span className="flex-shrink-0">{item.icon}</span>
                  {!effectiveCollapsed && <span className="flex-1 truncate">{item.label}</span>}
                  {!effectiveCollapsed && item.badge ? (
                    <span className="ml-auto rounded-full bg-ferro-signal text-ferro-ink text-overline font-semibold px-1.5 py-0.5 leading-none">
                      {item.badge}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* User */}
        <div className="border-t border-white/15">
          <div
            className={`flex items-center py-4 ${
              effectiveCollapsed ? 'justify-center px-0' : 'gap-3 px-4'
            }`}
          >
            <div className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-caption font-semibold">{initials}</span>
            </div>
            {!effectiveCollapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-white text-caption truncate">{user?.email}</p>
                <p className="text-white/60 text-overline">{role ? ROLE_LABEL[role] : ''}</p>
              </div>
            )}
            <button
              onClick={() => void signOut()}
              className="w-8 h-8 flex items-center justify-center rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors duration-fast flex-shrink-0"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0 bg-white">
        {/* Header */}
        <header className="flex items-center justify-between h-16 px-6 bg-white border-b border-border-default flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-raised transition-colors duration-fast -ml-1 flex-shrink-0"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <h1 className="text-subtitle font-semibold text-text-primary truncate">{title}</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-ferro-tint flex items-center justify-center flex-shrink-0">
              <span className="text-ferro-deep text-caption font-semibold">{initials}</span>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  )
}
