import type { KeyboardEvent, MutableRefObject } from 'react'

type ScreenProps = {
  screen: 'phone' | 'otp'
  phoneNumber: string
  setPhoneNumber: (value: string) => void
  digits: string[]
  digitRefs: MutableRefObject<(HTMLInputElement | null)[]>
  countdown: number
  error: string
  loading: boolean
  formatPhoneNumber: (value: string) => string
  handleSendOtp: () => Promise<void>
  handleVerifyOtp: () => Promise<void>
  handleDigitChange: (index: number, value: string) => void
  handleDigitKeyDown: (index: number, event: KeyboardEvent<HTMLInputElement>) => void
  handleGoBack: () => void
  handleResendOtp: () => Promise<void>
}

export default function SignInScreen({
  screen,
  phoneNumber,
  setPhoneNumber,
  digits,
  digitRefs,
  countdown,
  error,
  loading,
  formatPhoneNumber,
  handleSendOtp,
  handleVerifyOtp,
  handleDigitChange,
  handleDigitKeyDown,
  handleGoBack,
  handleResendOtp,
}: ScreenProps) {
  return (
    <main>
      <section className="pg-hero blue">
        <div className="wrap center-t">
          <span className="kicker">Sign in</span>
          <h1 className="huge">Ferro Maps</h1>
          <p className="lead">London&apos;s navigation for income</p>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap narrow">
          {screen === 'phone' ? (
            <form
              className="card-form"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSendOtp()
              }}
            >
              <h2 className="big">Enter your phone number</h2>
              <p className="lead">We&apos;ll text you a 6-digit code to verify it&apos;s you.</p>
              <label>
                UK mobile
                <input
                  type="tel"
                  inputMode="numeric"
                  placeholder="7XXXXXXXXX"
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value.replace(/\D/g, ''))}
                  disabled={loading}
                  aria-label="Phone number"
                />
              </label>
              <button className="btn btn-blue" type="submit" disabled={loading}>
                {loading ? 'Sending...' : 'Continue'}
              </button>
              {error ? <p className="ok">{error}</p> : null}
              <p className="note">
                By continuing, you agree to our <a href="/v2/terms-conditions">Terms</a> and{' '}
                <a href="/v2/privacy-policy">Privacy Policy</a>. We&apos;ll text you a code; standard rates may apply.
              </p>
            </form>
          ) : (
            <form
              className="card-form"
              onSubmit={(event) => {
                event.preventDefault()
                void handleVerifyOtp()
              }}
            >
              <button className="btn btn-white sm" type="button" onClick={handleGoBack} disabled={loading}>
                Back
              </button>
              <h2 className="big">Enter the 6-digit code</h2>
              <p className="lead">
                Sent to +44 {formatPhoneNumber(phoneNumber)}{' '}
                <button type="button" onClick={handleGoBack} disabled={loading}>
                  Edit
                </button>
              </p>
              <div className="seg">
                {digits.map((digit, index) => (
                  <input
                    key={index}
                    ref={(element) => {
                      digitRefs.current[index] = element
                    }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    autoComplete={index === 0 ? 'one-time-code' : 'off'}
                    value={digit}
                    onChange={(event) => handleDigitChange(index, event.target.value)}
                    onKeyDown={(event) => handleDigitKeyDown(index, event)}
                    disabled={loading}
                    aria-label={`Digit ${index + 1}`}
                    style={{ width: 48, textAlign: 'center', fontSize: 24 }}
                  />
                ))}
              </div>
              <button className="btn btn-blue" type="submit" disabled={loading || digits.join('').length !== 6}>
                {loading ? 'Verifying...' : 'Verify'}
              </button>
              {error ? <p className="ok">{error}</p> : null}
              <p className="note">
                {countdown > 0 ? (
                  `Resend code in 0:${countdown.toString().padStart(2, '0')}`
                ) : (
                  <button type="button" onClick={() => void handleResendOtp()} disabled={loading}>
                    Resend code
                  </button>
                )}
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  )
}
