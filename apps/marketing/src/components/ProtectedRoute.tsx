import { useAuth } from '../context/useAuth'
import { Navigate } from 'react-router-dom'

export default function ProtectedRoute({
  children,
  signInPath = '/signin',
}: {
  children: React.ReactNode
  signInPath?: string
}) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin border-4 border-ferro-primary border-t-transparent rounded-full w-10 h-10" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to={signInPath} replace />
  }

  return <>{children}</>
}
