import { useEffect, useState, type ReactNode } from 'react'
import { Helmet } from 'react-helmet-async'
import './prose.css'

const NAV = [
  ['/mission', 'Mission'],
  ['/how-it-works', 'How it works'],
  ['/stories', 'Driver stories'],
  ['/socials', 'Socials'],
  ['/contact', 'Contact'],
] as const

export default function V2Chrome({ title, children }: { title: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/site/assets/style.css'
    link.dataset.v2Adopted = '1'
    document.head.append(link)
    return () => {
      link.remove()
      document.body.classList.remove('menu-open')
    }
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={menuOpen ? 'menu-open' : undefined}>
      <Helmet>
        <title>{title}</title>
      </Helmet>
      <header className="nav">
        <a className="brand" href="/" aria-label="Ferro Maps home">
          <img src="/site/assets/img/bird-blue-96.webp" width={48} height={48} alt="" />
          <span>Ferro Maps</span>
        </a>
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
            {NAV.map(([href, label]) => (
              <li key={href}>
                <a href={href}>{label}</a>
              </li>
            ))}
            <li>
              <a className="btn btn-blue sm navcta" href="/jobs">
                Join jobs waitlist
              </a>
            </li>
          </ul>
        </nav>
      </header>
      {children}
      <footer>
        <div className="wrap foot">
          <div className="brand">
            <img src="/site/assets/img/bird-blue-96.webp" width={48} height={48} alt="" />
            <span>Ferro Maps</span>
          </div>
          <div>
            {NAV.map(([href, label]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
            <a href="/jobs">Jobs waitlist</a>
            <a href="/waitlist">City waitlist</a>
            <a href="/signin">Sign in</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/privacy-policy">Privacy</a>
            <a href="/terms-conditions">Terms</a>
            <a href="https://www.instagram.com/ferromaps/" target="_blank" rel="noopener noreferrer">
              Instagram
            </a>
            <a href="https://www.tiktok.com/@ferro.maps" target="_blank" rel="noopener noreferrer">
              TikTok
            </a>
            <a href="https://www.facebook.com/profile.php?id=61592890509710" target="_blank" rel="noopener noreferrer">
              Facebook
            </a>
          </div>
          <p>Ferro Maps © 2026 · London · Made for drivers</p>
          <p className="tm">
            Uber, Bolt, the Premier League and club names and crests belong to their owners. Ferro Maps is independent
            and not affiliated with or endorsed by them.
          </p>
        </div>
      </footer>
    </div>
  )
}
