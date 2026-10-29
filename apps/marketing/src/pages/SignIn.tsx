import { useState, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Home } from 'lucide-react'
import {
  signInWithPhoneNumber,
  RecaptchaVerifier,
} from 'firebase/auth'
import type { ConfirmationResult } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import ferroLogo from '../assets/ferro-logo-2.png'
import SignInScreen from '../v2-adopted/SignInScreen'

type SignInState = 'phone' | 'otp'

export default function SignIn({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()

  const [screen, setScreen] = useState<SignInState>('phone')
  const [phoneNumber, setPhoneNumber] = useState('')

  // OTP state
  const [digits, setDigits] = useState<string[]>([
    '',
    '',
    '',
    '',
    '',
    '',
  ])
  const [countdown, setCountdown] = useState(59)

  const digitRefs = useRef<(HTMLInputElement | null)[]>([])
  const recaptchaVerifierRef =
    useRef<RecaptchaVerifier | null>(null)

  const [confirmationResult, setConfirmationResult] =
    useState<ConfirmationResult | null>(null)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /*
   * Do not create reCAPTCHA immediately on page load.
   * Create it only when the user requests an OTP.
   */
  function getRecaptchaVerifier() {
    if (recaptchaVerifierRef.current) {
      return recaptchaVerifierRef.current
    }

    const verifier = new RecaptchaVerifier(
      auth,
      'recaptcha-container',
      {
        size: 'invisible',

        callback: () => {
          console.log('reCAPTCHA completed successfully')
        },

        'expired-callback': () => {
          console.warn('reCAPTCHA expired')
          clearRecaptchaVerifier()
        },
      }
    )

    recaptchaVerifierRef.current = verifier

    return verifier
  }

  function clearRecaptchaVerifier() {
    if (recaptchaVerifierRef.current) {
      recaptchaVerifierRef.current.clear()
      recaptchaVerifierRef.current = null
    }

    /*
     * Firebase/reCAPTCHA may leave generated elements inside
     * the container. Remove them before creating another verifier.
     */
    const container = document.getElementById(
      'recaptcha-container'
    )

    if (container) {
      container.innerHTML = ''
    }
  }

  /*
   * Clear the verifier when leaving the Sign In page.
   */
  useEffect(() => {
    return () => {
      if (recaptchaVerifierRef.current) {
        recaptchaVerifierRef.current.clear()
        recaptchaVerifierRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (screen !== 'otp') return

    const interval = window.setInterval(() => {
      setCountdown(previous => {
        if (previous <= 1) {
          window.clearInterval(interval)
          return 0
        }

        return previous - 1
      })
    }, 1000)

    return () => window.clearInterval(interval)
  }, [screen])

  function formatPhoneNumber(value: string) {
    let cleaned = value.replace(/\D/g, '')

    /*
     * This lets users enter either:
     * 7
     * or
     * 07
     */
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.slice(1)
    }

    return cleaned
  }

  async function handleSendOtp() {
    if (loading) return

    setError('')

    const cleanedNumber = formatPhoneNumber(phoneNumber)

    if (cleanedNumber.length !== 10) {
      setError(
        'Please enter a valid UK mobile number, for example 7904404382.'
      )
      return
    }

    setLoading(true)

    try {
      /*
       * Create one verifier and pass that same instance
       * to Firebase.
       */
      const verifier = getRecaptchaVerifier()

      const fullNumber = `+44${cleanedNumber}`

      console.log('Attempting to send OTP to:', fullNumber)

      const result = await signInWithPhoneNumber(
        auth,
        fullNumber,
        verifier
      )

      setConfirmationResult(result)
      setDigits(['', '', '', '', '', ''])
      setCountdown(59)
      setScreen('otp')
    } catch (unknownError: unknown) {
      const firebaseError = unknownError as {
        code?: string
        message?: string
      }

      console.error('Failed to send OTP:', {
        code: firebaseError.code,
        message: firebaseError.message,
        fullError: unknownError,
      })

      /*
       * A failed or used verifier should not be reused.
       * Clear it so the next click creates a fresh verifier.
       */
      clearRecaptchaVerifier()

      switch (firebaseError.code) {
        case 'auth/invalid-phone-number':
          setError('Please enter a valid UK mobile number.')
          break

        case 'auth/too-many-requests':
          setError(
            'Too many attempts have been made. Please wait before trying again.'
          )
          break

        case 'auth/quota-exceeded':
          setError(
            'The SMS sending limit has been reached. Please try again later.'
          )
          break

        case 'auth/unauthorized-domain':
          setError(
            'This website domain has not been authorised in Firebase.'
          )
          break

        case 'auth/captcha-check-failed':
        case 'auth/invalid-app-credential':
          setError(
            'The security check failed. Please refresh the page and try again.'
          )
          break

        default:
          setError(
            firebaseError.code
              ? `Failed to send code: ${firebaseError.code}`
              : 'Failed to send code. Please try again.'
          )
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOtp() {
    if (loading) return

    setError('')

    const code = digits.join('')

    if (code.length !== 6) {
      setError('Please enter the complete 6-digit code.')
      return
    }

    if (!confirmationResult) {
      setError(
        'Your verification request has expired. Please request a new code.'
      )
      setScreen('phone')
      return
    }

    setLoading(true)

    try {
      const userCredential =
        await confirmationResult.confirm(code)

      const user = userCredential.user

      const userDoc = await getDoc(
        doc(db, 'users', user.uid)
      )

      if (!userDoc.exists()) {
        setError(
          'No Ferro Maps account found. Please download the app to register.'
        )

        setConfirmationResult(null)
        setDigits(['', '', '', '', '', ''])
        setScreen('phone')

        if (embedded) {
          navigate('/v2#download')
        } else {
          setTimeout(() => {
            document
              .getElementById('download')
              ?.scrollIntoView({ behavior: 'smooth' })
          }, 2000)
        }

        return
      }

      navigate(embedded ? '/v2/dashboard' : '/dashboard')
    } catch (unknownError: unknown) {
      const firebaseError = unknownError as {
        code?: string
        message?: string
      }

      console.error('Failed to verify OTP:', {
        code: firebaseError.code,
        message: firebaseError.message,
        fullError: unknownError,
      })

      if (firebaseError.code === 'auth/code-expired') {
        setError(
          'This code has expired. Please go back and request a new one.'
        )
      } else {
        setError('Invalid code. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  function handleDigitChange(
    index: number,
    value: string
  ) {
    const digit = value.replace(/\D/g, '').slice(-1)

    const next = [...digits]
    next[index] = digit
    setDigits(next)

    if (digit && index < 5) {
      digitRefs.current[index + 1]?.focus()
    }
  }

  function handleDigitKeyDown(
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>
  ) {
    if (
      event.key === 'Backspace' &&
      !digits[index] &&
      index > 0
    ) {
      digitRefs.current[index - 1]?.focus()
    }
  }

  function handleGoBack() {
    setDigits(['', '', '', '', '', ''])
    setConfirmationResult(null)
    setError('')
    setCountdown(59)
    setScreen('phone')

    /*
     * The previous verifier has already been used to send an SMS.
     * Clear it so another attempt creates a fresh one.
     */
    clearRecaptchaVerifier()
  }

  async function handleResendOtp() {
    /*
     * Return to the phone step and make a completely new
     * signInWithPhoneNumber request.
     */
    setDigits(['', '', '', '', '', ''])
    setConfirmationResult(null)
    setError('')
    clearRecaptchaVerifier()

    await handleSendOtp()
  }

  if (embedded) {
    return (
      <>
        <SignInScreen
          screen={screen}
          phoneNumber={phoneNumber}
          setPhoneNumber={setPhoneNumber}
          digits={digits}
          digitRefs={digitRefs}
          countdown={countdown}
          error={error}
          loading={loading}
          formatPhoneNumber={formatPhoneNumber}
          handleSendOtp={handleSendOtp}
          handleVerifyOtp={handleVerifyOtp}
          handleDigitChange={handleDigitChange}
          handleDigitKeyDown={handleDigitKeyDown}
          handleGoBack={handleGoBack}
          handleResendOtp={handleResendOtp}
        />
        <div id="recaptcha-container" className="fixed bottom-0 right-0 z-[-1]" aria-hidden="true" />
      </>
    )
  }

  return (
    <div className="min-h-screen bg-[#1E7BFF] flex flex-col items-center justify-center px-4">
      <Link
        to="/"
        aria-label="Home"
        className="fixed top-6 left-6 text-white hover:text-white/70 transition-colors duration-fast"
      >
        <Home size={22} />
      </Link>

      <Link to="/">
        <img
          src={ferroLogo}
          alt="Ferro Maps"
          className="w-24 h-24 rounded-2xl mb-6"
        />
      </Link>

      <h1 className="text-3xl font-bold text-white mb-2">
        Ferro Maps
      </h1>

      <p className="text-base text-white opacity-90">
        London's navigation for income
      </p>

      {screen === 'phone' && (
        <>
          <h2 className="text-white font-bold text-xl text-center mb-2 mt-8">
            Enter your phone number
          </h2>

          <p className="text-white text-sm text-center mb-6 opacity-90">
            We'll text you a 6-digit code to verify it's you.
          </p>

          <div className="bg-white rounded-2xl p-8 w-full max-w-sm mx-auto shadow-lg">
            <div className="flex gap-3 mb-4">
              <div className="flex items-center gap-2 bg-gray-100 rounded-lg px-4 py-3 text-sm font-semibold text-neutral-700 whitespace-nowrap">
                🇬🇧 +44
              </div>

              <input
                type="tel"
                inputMode="numeric"
                placeholder="7XXXXXXXXX"
                value={phoneNumber}
                onChange={event =>
                  setPhoneNumber(
                    event.target.value.replace(/\D/g, '')
                  )
                }
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void handleSendOtp()
                  }
                }}
                disabled={loading}
                className="flex-1 min-w-0 border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-ferro-primary disabled:opacity-60"
              />
            </div>

            <button
              type="button"
              onClick={() => void handleSendOtp()}
              disabled={loading}
              className="bg-ferro-primary text-white rounded-lg py-3 font-semibold text-sm tracking-widest uppercase w-full disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? 'Sending...' : 'Continue'}
            </button>

            {error && (
              <p className="text-red-500 text-sm text-center mt-3">
                {error}
              </p>
            )}
          </div>

          <p className="text-white text-xs text-center mt-6 opacity-75 max-w-sm mx-auto">
            By continuing, you agree to our Terms and Privacy
            Policy. We'll text you a code; standard rates may
            apply.
          </p>
        </>
      )}

      {screen === 'otp' && (
        <>
          <div className="w-full max-w-sm mx-auto mt-8">
            <button
              type="button"
              onClick={handleGoBack}
              disabled={loading}
              className="flex items-center gap-1 text-white/70 hover:text-white transition-colors duration-fast text-sm font-semibold disabled:opacity-60"
            >
              <ArrowLeft size={16} />
              Back
            </button>
          </div>

          <h2 className="text-white font-bold text-xl text-center mb-2 mt-4">
            Enter the 6-digit code
          </h2>

          <p className="text-white text-sm text-center mb-6 opacity-90">
            Sent to +44 {formatPhoneNumber(phoneNumber)}

            <button
              type="button"
              onClick={handleGoBack}
              disabled={loading}
              className="font-bold cursor-pointer underline ml-1 disabled:opacity-60"
            >
              Edit
            </button>
          </p>

          <div className="bg-white rounded-2xl p-8 w-full max-w-sm mx-auto shadow-lg">
            <div className="flex gap-3 justify-center mb-6">
              {digits.map((digit, index) => (
                <input
                  key={index}
                  ref={element => {
                    digitRefs.current[index] = element
                  }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  autoComplete={
                    index === 0 ? 'one-time-code' : 'off'
                  }
                  value={digit}
                  onChange={event =>
                    handleDigitChange(
                      index,
                      event.target.value
                    )
                  }
                  onKeyDown={event =>
                    handleDigitKeyDown(index, event)
                  }
                  disabled={loading}
                  className="w-12 h-14 text-center text-xl font-bold border-2 border-gray-200 rounded-xl focus:outline-none focus:border-ferro-primary disabled:opacity-60"
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() => void handleVerifyOtp()}
              disabled={
                loading || digits.join('').length !== 6
              }
              className="bg-ferro-primary text-white rounded-lg py-3 font-semibold text-sm tracking-widest uppercase w-full disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>

            {error && (
              <p className="text-red-500 text-sm text-center mt-3">
                {error}
              </p>
            )}

            <div className="text-gray-500 text-sm text-center mt-4">
              {countdown > 0 ? (
                `Resend code in 0:${countdown
                  .toString()
                  .padStart(2, '0')}`
              ) : (
                <button
                  type="button"
                  onClick={() => void handleResendOtp()}
                  disabled={loading}
                  className="cursor-pointer underline disabled:opacity-60"
                >
                  Resend code
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/*
        Keep the container mounted and available to reCAPTCHA.
      */}
      <div
        id="recaptcha-container"
        className="fixed bottom-0 right-0 z-[-1]"
        aria-hidden="true"
      />
    </div>
  )
}