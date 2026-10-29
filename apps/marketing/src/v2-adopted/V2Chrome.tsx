import { useEffect, useState, type ReactNode } from 'react'
import { Helmet } from 'react-helmet-async'
import './prose.css'

const NAV = [
  ['/v2/mission', 'Mission'],
  ['/v2/how-it-works', 'How it works'],
  ['/v2/stories', 'Driver stories'],
  ['/v2/socials', 'Socials'],
  ['/v2/contact', 'Contact'],
] as const

export default function V2Chrome({ title, children }: { title: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/v2/assets/style.css'
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
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <header className="nav">
        <a className="brand" href="/v2/" aria-label="Ferro Maps home">
          <img src="/v2/assets/img/bird-blue-96.webp" width={48} height={48} alt="" />
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
              <a className="btn btn-blue sm navcta" href="/v2/jobs">
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
            <img src="/v2/assets/img/bird-blue-96.webp" width={48} height={48} alt="" />
            <span>Ferro Maps</span>
          </div>
          <div>
            {NAV.map(([href, label]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
            <a href="/v2/jobs">Jobs waitlist</a>
            <a href="/v2/waitlist">City waitlist</a>
            <a href="/v2/signin">Sign in</a>
            <a href="/v2/dashboard">Dashboard</a>
            <a href="/v2/privacy-policy">Privacy</a>
            <a href="/v2/terms-conditions">Terms</a>
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
