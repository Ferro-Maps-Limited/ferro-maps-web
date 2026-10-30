import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import { AuthProvider } from './context/AuthContext'
import ScrollToTop from './components/ScrollToTop'
import { V2Dashboard, V2Privacy, V2SignIn, V2Terms, V2Ticket, V2Waitlist, V2WaitlistConfirmed } from './v2-adopted/pages'
import AccountDeletedNotice from './components/AccountDeletedNotice'

// The home page and the other marketing pages are static HTML served by
// Vercel (public/site). When the app navigates to one of them, or lands on a
// path it doesn't know, load it from the server instead of rendering nothing.
const SERVER_PAGES = ['/', '/mission', '/how-it-works', '/stories', '/socials', '/contact', '/jobs']
const FIRST_PATH = window.location.pathname

function ServerPage() {
  const location = useLocation()

  useEffect(() => {
    const target = SERVER_PAGES.includes(location.pathname) ? location.pathname : '/'
    // If the server already answered this exact path with the app, reloading
    // it would loop, so only leave when the target is somewhere else.
    if (target === FIRST_PATH && location.pathname === FIRST_PATH) return
    window.location.replace(target + location.search + location.hash)
  }, [location])

  return null
}

export default function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <ScrollToTop />
        <AuthProvider>
          <AccountDeletedNotice />
          <Routes>
            <Route path="/privacy-policy" element={<V2Privacy />} />
            <Route path="/terms-conditions" element={<V2Terms />} />
            <Route path="/signin" element={<V2SignIn />} />
            <Route path="/dashboard" element={<V2Dashboard />} />
            <Route path="/ticket/:token" element={<V2Ticket />} />
            <Route path="/waitlist" element={<V2Waitlist />} />
            <Route path="/waitlist/confirmed" element={<V2WaitlistConfirmed />} />
            <Route path="*" element={<ServerPage />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </HelmetProvider>
  )
}
