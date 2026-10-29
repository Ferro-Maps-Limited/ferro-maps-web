import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import Header from './Header'
import Hero from './Hero'
import WhyFerroMaps from './WhyFerroMaps'
import HowItWorks from './HowItWorks'
import Testimonials from './Testimonials'
import AppScreenshots from './AppScreenshots'
import Contact from './Contact'
import DownloadBanner from './DownloadBanner'
import Footer from './Footer'
import PrivacyPolicy from './pages/PrivacyPolicy'
import TermsConditions from './pages/TermsConditions'
import SignIn from './pages/SignIn'
import Dashboard from './pages/Dashboard'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import ScrollToTop from './components/ScrollToTop'
import TicketView from './pages/TicketView'
import Waitlist from './pages/Waitlist'
import WaitlistConfirmed from './pages/WaitlistConfirmed'

const V2Routes = lazy(() => import('./v2/V2Routes'))

function Home() {
  const location = useLocation()

  useEffect(() => {
    if (location.hash) {
      const id = location.hash.slice(1)
      const timer = setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [location.hash])

  useEffect(() => {
    const sections = document.querySelectorAll('.section-fade')

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('section-visible')
          } else {
            entry.target.classList.remove('section-visible')
          }
        })
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
    )

    sections.forEach((el) => {
      observer.observe(el)
    })

    return () => observer.disconnect()
  }, [])

  return (
    <div className="min-h-screen bg-white text-text-primary font-sans">
      <Header />
      <div className="animate-fade-up"><Hero /></div>

      <main>
        <div className="section-fade"><WhyFerroMaps /></div>
        <div className="section-fade"><AppScreenshots /></div>
        <div className="section-fade"><HowItWorks /></div>
        <div className="section-fade"><Testimonials /></div>
      </main>

      <div className="section-fade"><DownloadBanner /></div>
      <div className="section-fade"><Contact /></div>
      <div className="section-fade"><Footer /></div>
    </div>
  )
}

export default function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <ScrollToTop />
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/privacy-policy" element={<PrivacyPolicy />} />
            <Route path="/terms-conditions" element={<TermsConditions />} />
            <Route path="/signin" element={<SignIn />} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/ticket/:token" element={<TicketView />} />
            <Route path="/waitlist" element={<Waitlist />} />
            <Route path="/waitlist/confirmed" element={<WaitlistConfirmed />} />
            <Route
              path="/v2/*"
              element={
                <Suspense fallback={<div className="min-h-screen bg-white" />}>
                  <V2Routes />
                </Suspense>
              }
            />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </HelmetProvider>
  )
}
