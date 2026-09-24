import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { homeFor } from './lib/roles'
import ProtectedRoute from './components/ProtectedRoute'
import PublicOnlyRoute from './components/PublicOnlyRoute'
import SignIn from './pages/SignIn'
import Dashboard from './pages/Dashboard'
import Drivers from './pages/Drivers'
import Settings from './pages/Settings'
import Messages from './pages/Messages'
import Waitlist from './pages/Waitlist'
import SystemHealth from './pages/SystemHealth'
import DriverProfile from './pages/DriverProfile'
import LiveMap from './pages/LiveMap'
import Hotspots from './pages/Hotspots'
import Engagement from './pages/Engagement'
import Growth from './pages/Growth'
import Community from './pages/Community'

// Sends each role to its own landing page. Rendered inside a ProtectedRoute,
// which has already turned away anyone without a staff role.
function RoleHome() {
  const { role } = useAuth()
  return <Navigate to={role ? homeFor(role) : '/login'} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicOnlyRoute>
                <SignIn />
              </PublicOnlyRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/drivers"
            element={
              <ProtectedRoute>
                <Drivers />
              </ProtectedRoute>
            }
          />
          <Route
            path="/drivers/:uid"
            element={
              <ProtectedRoute>
                <DriverProfile />
              </ProtectedRoute>
            }
          />
          <Route
            path="/messages"
            element={
              <ProtectedRoute allow={['admin', 'support']}>
                <Messages />
              </ProtectedRoute>
            }
          />
          <Route
            path="/waitlist"
            element={
              <ProtectedRoute>
                <Waitlist />
              </ProtectedRoute>
            }
          />
          <Route
            path="/map"
            element={
              <ProtectedRoute>
                <LiveMap />
              </ProtectedRoute>
            }
          />
          <Route
            path="/hotspots"
            element={
              <ProtectedRoute>
                <Hotspots />
              </ProtectedRoute>
            }
          />
          <Route
            path="/engagement"
            element={
              <ProtectedRoute>
                <Engagement />
              </ProtectedRoute>
            }
          />
          <Route
            path="/growth"
            element={
              <ProtectedRoute>
                <Growth />
              </ProtectedRoute>
            }
          />
          <Route
            path="/community"
            element={
              <ProtectedRoute>
                <Community />
              </ProtectedRoute>
            }
          />
          <Route
            path="/system"
            element={
              <ProtectedRoute>
                <SystemHealth />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute allow={['admin', 'support']}>
                <RoleHome />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
