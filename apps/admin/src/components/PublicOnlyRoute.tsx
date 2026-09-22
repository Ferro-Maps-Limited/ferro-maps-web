import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { homeFor } from '../lib/roles'

export default function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { user, role, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-ferro-tint">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    )
  }

  if (user && role) {
    return <Navigate to={homeFor(role)} replace />
  }

  return children
}
