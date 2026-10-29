import Seo from '../Seo'
import { VerifiedIcon } from '../icons'
import { LINKEDIN } from '../facts'
import { FACEBOOK, INSTAGRAM, TIKTOK } from '../links'

export default function SocialsPage() {
  return (
    <main>
      <Seo
        title="Follow us — Ferro Maps"
        description="Official Ferro Maps accounts on Instagram, TikTok and Facebook."
        path="/v2/socials"
      />
      <section className="soc-hero">
        <div className="wrap soc-grid">
          <div>
            <div className="soc-id">
              <img
                className="gold-av"
                src="/brand/img/gold-avatar.webp"
                width={120}
                height={120}
                alt="Ferro gold bird"
              />
              <div className="official">
                <VerifiedIcon size={56} />
                <span>Official Ferro accounts</span>
              </div>
            </div>
            <h1 className="huge">Follow us.</h1>
            <p className="lead">Follow Ferro on Instagram, TikTok, Facebook and LinkedIn.</p>
          </div>
          <div className="soc-art">
            <img
              src="/brand/img/socials-hero-1400.webp"
              srcSet="/brand/img/socials-hero-800.webp 800w, /brand/img/socials-hero-1400.webp 1400w"
              sizes="(max-width:900px) 92vw, 560px"
              width={1400}
              height={1400}
              alt="Driver in a white Tesla with the Ferro bird holding a map, over a blue London skyline"
              fetchPriority="high"
            />
          </div>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap narrow">
          <ul className="soc-list">
            <li>
              <a className="soc-card ig" href={INSTAGRAM} target="_blank" rel="noopener noreferrer">
                <span className="soc-ic">
                  <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
                    <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
                    <circle cx="12" cy="12" r="4.3" fill="none" stroke="currentColor" strokeWidth="2.2" />
                    <circle cx="17.4" cy="6.6" r="1.4" fill="currentColor" />
                  </svg>
                </span>
                <span className="soc-txt">
                  <b>Instagram</b>
                  <span className="handle">
                    @ferromaps
                    <VerifiedIcon />
                  </span>
                  <span className="ig-ver">Verified on Instagram</span>
                </span>
                <span className="btn btn-blue sm soc-btn">
                  Follow
                  <span className="sr"> (opens in new tab)</span>
                </span>
              </a>
            </li>
            <li>
              <a className="soc-card tt" href={TIKTOK} target="_blank" rel="noopener noreferrer">
                <span className="soc-ic">
                  <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M16.6 2h-3.4v13.3a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9a6.4 6.4 0 1 0 5.4 6.3V8.6a8 8 0 0 0 4.6 1.5V6.7a4.7 4.7 0 0 1-4.6-4.7z"
                    />
                  </svg>
                </span>
                <span className="soc-txt">
                  <b>TikTok</b>
                  <span className="handle">
                    @ferro.maps
                    <VerifiedIcon />
                  </span>
                </span>
                <span className="btn btn-blue sm soc-btn">
                  Follow
                  <span className="sr"> (opens in new tab)</span>
                </span>
              </a>
            </li>
            <li>
              <a className="soc-card fb" href={FACEBOOK} target="_blank" rel="noopener noreferrer">
                <span className="soc-ic">
                  <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M13.5 22v-8.2h2.8l.4-3.3h-3.2V8.4c0-.9.3-1.6 1.6-1.6h1.7V3.9c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7.3v3.3h2.8V22z"
                    />
                  </svg>
                </span>
                <span className="soc-txt">
                  <b>Facebook</b>
                  <span className="handle">
                    Ferro Maps
                    <VerifiedIcon />
                  </span>
                </span>
                <span className="btn btn-blue sm soc-btn">
                  Follow
                  <span className="sr"> (opens in new tab)</span>
                </span>
              </a>
            </li>
            <li>
              <a className="soc-card" href={LINKEDIN} target="_blank" rel="noopener noreferrer">
                <span className="soc-ic" style={{ background: '#0A66C2' }}>
                  <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M6.5 9H3.7v11.2h2.8V9zM5.1 3.8A1.7 1.7 0 1 0 5.1 7a1.7 1.7 0 0 0 0-3.2zM20.3 13.4c0-3.2-1.7-4.7-4-4.7-1.8 0-2.7 1-3.2 1.7V9H10.3c0 1.8 0 11.2 0 11.2h2.8v-6.3c0-.3 0-.7.1-1 .3-.7.9-1.4 2-1.4 1.4 0 2 1.1 2 2.6v6.1h2.8v-6.8z"
                    />
                  </svg>
                </span>
                <span className="soc-txt">
                  <b>LinkedIn</b>
                  <span className="handle">Ferro Maps</span>
                </span>
                <span className="btn btn-blue sm soc-btn">
                  Follow
                  <span className="sr"> (opens in new tab)</span>
                </span>
              </a>
            </li>
          </ul>
          <p className="soc-note">
            <VerifiedIcon size={14} /> = an official Ferro account. Only follow these.
          </p>
        </div>
      </section>
    </main>
  )
}
