import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import Seo from '../Seo'
import { DownloadStrip } from '../download'
import { COMPANY, COMPANY_NUMBER, faqs, REGISTERED_OFFICE, SUPPORT_EMAIL } from '../facts'
import { FACEBOOK, INSTAGRAM, TIKTOK } from '../links'
import { submitSupportRequest } from '../supportRequest'

export default function ContactPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!agreed) return
    setLoading(true)
    setSuccess(false)
    setError(false)
    try {
      await submitSupportRequest({ name, email, message, agreedToPolicy: agreed })
      setSuccess(true)
      setName('')
      setEmail('')
      setMessage('')
      setAgreed(false)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main>
      <Seo
        title="Contact — Ferro Maps"
        description="Contact Ferro Maps Ltd. Send a message and we open a support ticket."
        path="/v2/contact"
      />
      <section className="pg-hero blue">
        <div className="wrap center-t">
          <span className="kicker">Contact</span>
          <h1 className="huge">Say hello.</h1>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap narrow">
          <form className="card-form" onSubmit={onSubmit}>
            <label>
              Name
              <input
                name="name"
                autoComplete="name"
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                maxLength={320}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Message
              <textarea
                name="message"
                rows={5}
                maxLength={5000}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                required
              />
            </label>
            <label className="consent">
              <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} required />
              <span>
                I agree to the <Link to="/privacy-policy">Privacy Policy</Link>
              </span>
            </label>
            <button className="btn btn-blue" type="submit" disabled={loading}>
              {loading ? 'Sending…' : 'Send message'}
            </button>
            {success ? (
              <p className="form-status ok" role="status">
                Message sent! We&apos;ll be in touch soon.
              </p>
            ) : null}
            {error ? (
              <p className="form-status error" role="alert">
                Something went wrong. Please try support@ferromaps.com
              </p>
            ) : null}
            <p className="note">
              This opens a support ticket for {SUPPORT_EMAIL}. {COMPANY}, company no. {COMPANY_NUMBER}.{' '}
              {REGISTERED_OFFICE}.
            </p>
          </form>
          <div className="faq">
            <h2 className="big center-t">Common questions</h2>
            {faqs.map((faq) => (
              <details key={faq.q}>
                <summary>{faq.q}</summary>
                <p>{faq.a}</p>
              </details>
            ))}
          </div>
          <div className="socials">
            <a className="btn btn-white sm" href={INSTAGRAM} target="_blank" rel="noopener noreferrer">
              Instagram
            </a>
            <a className="btn btn-white sm" href={TIKTOK} target="_blank" rel="noopener noreferrer">
              TikTok
            </a>
            <a className="btn btn-white sm" href={FACEBOOK} target="_blank" rel="noopener noreferrer">
              Facebook
            </a>
          </div>
        </div>
      </section>
      <DownloadStrip />
    </main>
  )
}
