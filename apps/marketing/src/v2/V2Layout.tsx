import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { DownloadProvider } from './download'
import { useAuth } from '../context/useAuth'
import { COMPANY, COMPANY_NUMBER, LINKEDIN, REGISTERED_OFFICE, SUPPORT_EMAIL } from './facts'
import { FACEBOOK, INSTAGRAM, TIKTOK } from './links'

const NAV = [
  { to: '/v2/mission', label: 'Mission' },
  { to: '/v2/how-it-works', label: 'How it works' },
  { to: '/v2/stories', label: 'Driver stories' },
  { to: '/v2/socials', label: 'Socials' },
  { to: '/v2/contact', label: 'Contact' },
]

export default function V2Layout() {
  const { pathname } = useLocation()
  const { user } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPath, setMenuPath] = useState(pathname)
  if (pathname !== menuPath) {
    setMenuPath(pathname)
    setMenuOpen(false)
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={menuOpen ? 'v2 menu-open' : 'v2'}>
      <DownloadProvider>
        <header className="nav">
          <Link className="brand" to="/v2" aria-label="Ferro Maps home" onClick={() => setMenuOpen(false)}>
            <img src="/brand/img/bird-blue-96.webp" width={48} height={48} alt="" />
            <span>Ferro Maps</span>
          </Link>
          <button
            className="menu-btn"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
          <nav id="site-menu" className="site-menu" aria-label="Main" onClick={() => setMenuOpen(false)}>
            <ul>
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to}>{item.label}</NavLink>
                </li>
              ))}
              <li>
                <NavLink to={user ? '/dashboard' : '/signin'}>{user ? 'Dashboard' : 'Sign in'}</NavLink>
              </li>
              <li>
                <NavLink className="btn btn-blue sm navcta" to="/v2/jobs">
                  Join jobs waitlist
                </NavLink>
              </li>
            </ul>
          </nav>
        </header>
        <Outlet />
        <footer>
          <div className="wrap foot">
            <div className="brand">
              <img src="/brand/img/bird-blue-96.webp" width={48} height={48} alt="" />
              <span>Ferro Maps</span>
            </div>
            <div>
              {NAV.map((item) => (
                <Link key={item.to} to={item.to}>
                  {item.label}
                </Link>
              ))}
              <Link to="/v2/jobs">Jobs waitlist</Link>
              <Link to="/waitlist">City waitlist</Link>
              <Link to={user ? '/dashboard' : '/signin'}>{user ? 'Dashboard' : 'Sign in'}</Link>
              <Link to="/privacy-policy">Privacy</Link>
              <Link to="/terms-conditions">Terms</Link>
              <a href={INSTAGRAM} target="_blank" rel="noopener noreferrer">
                Instagram
              </a>
              <a href={TIKTOK} target="_blank" rel="noopener noreferrer">
                TikTok
              </a>
              <a href={FACEBOOK} target="_blank" rel="noopener noreferrer">
                Facebook
              </a>
              <a href={LINKEDIN} target="_blank" rel="noopener noreferrer">
                LinkedIn
              </a>
            </div>
            <p>
              {COMPANY} · Company no. {COMPANY_NUMBER} · {REGISTERED_OFFICE}
            </p>
            <p>© 2026 · London · Made for drivers · {SUPPORT_EMAIL}</p>
            <p className="tm">
              Uber and Bolt belong to their owners. Ferro Maps is independent and not affiliated with or endorsed by
              them. Ferro Maps shows demand. It does not guarantee earnings.
            </p>
          </div>
        </footer>
      </DownloadProvider>
    </div>
  )
}
