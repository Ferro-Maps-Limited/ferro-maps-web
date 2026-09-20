import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { homeFor, type StaffRole } from '../lib/roles'

type ProtectedRouteProps = {
  children: ReactNode
  // Roles that may open this page. Admin-only unless a page says otherwise.
  allow?: StaffRole[]
}

export default function ProtectedRoute({ children, allow = ['admin'] }: ProtectedRouteProps) {
  const { user, role, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-ferro-tint">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    )
  }

  if (!user || !role) {
    return <Navigate to="/login" replace />
  }

  if (!allow.includes(role)) {
    return <Navigate to={homeFor(role)} replace />
  }

  return children
}
