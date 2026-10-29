import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { isWaitlistEmail, joinWaitlist } from './waitlist'

type Status = 'idle' | 'submitting' | 'success' | 'duplicate' | 'error'

type WaitlistFormProps = {
  variant: 'inline' | 'card'
  buttonClassName: string
}

export default function WaitlistForm({ variant, buttonClassName }: WaitlistFormProps) {
  const emailId = useId()
  const consentId = useId()
  const [email, setEmail] = useState('')
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isWaitlistEmail(email)) {
      setStatus('error')
      setMessage('Please enter a valid email address.')
      return
    }
    if (!consent) {
      setStatus('error')
      setMessage('Please agree to be contacted before joining the waitlist.')
      return
    }
    setStatus('submitting')
    setMessage('')
    try {
      const result = await joinWaitlist(email)
      if (result === 'duplicate') {
        setStatus('duplicate')
        setMessage("You're already on the list.")
        return
      }
      setStatus('success')
      setMessage("You're on the list.")
      setEmail('')
      setConsent(false)
    } catch {
      setStatus('error')
      setMessage('Something went wrong. Please try again.')
    }
  }

  const formClass = variant === 'inline' ? 'wait' : 'card-form'

  return (
    <form className={formClass} onSubmit={onSubmit} noValidate>
      {status === 'success' ? (
        <p className="form-status ok" role="status">
          {message}
        </p>
      ) : (
        <>
          {variant === 'card' ? (
            <label htmlFor={emailId}>
              Email
              <input
                id={emailId}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@email.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
          ) : (
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@email.com"
              aria-label="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          )}
          <button className={buttonClassName} type="submit" disabled={status === 'submitting'}>
            {status === 'submitting' ? 'Joining…' : 'Join waitlist'}
          </button>
          <label className="consent" htmlFor={consentId}>
            <input
              id={consentId}
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I agree to be contacted about Ferro Maps and understand my data will be processed per the{' '}
              <Link to="/privacy-policy">Privacy Policy</Link>. I can withdraw consent at any time.
            </span>
          </label>
          {message ? (
            <p className={status === 'error' ? 'form-status error' : 'form-status'} role="status">
              {message}
            </p>
          ) : null}
        </>
      )}
    </form>
  )
}
