import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { Button, Card, Input } from '@ferro-maps/ui'
import Header from '../Header'
import Footer from '../Footer'
import { db } from '../lib/firebase'

function encodeEmailToDocId(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina', 'Armenia',
  'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium',
  'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
  'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada', 'Central African Republic', 'Chad',
  'Chile', 'China', 'Colombia', 'Comoros', 'Congo (Congo-Brazzaville)', 'Costa Rica', 'Croatia', 'Cuba',
  'Cyprus', 'Czechia', 'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia',
  'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana',
  'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica',
  'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon',
  'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi',
  'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico',
  'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia',
  'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea',
  'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama', 'Papua New Guinea',
  'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda',
  'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'San Marino',
  'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore',
  'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan',
  'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan',
  'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
  'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States',
  'Uruguay', 'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
]

export default function Waitlist({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [country, setCountry] = useState('')
  const [countryQuery, setCountryQuery] = useState('')
  const [countryOpen, setCountryOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [consent, setConsent] = useState(false)
  const [consentError, setConsentError] = useState('')
  const [alreadyOnList, setAlreadyOnList] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const countryInputRef = useRef<HTMLInputElement>(null)

  const filteredCountries = COUNTRIES.filter(c =>
    c.toLowerCase().includes(countryQuery.toLowerCase())
  )

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    if (!EMAIL_PATTERN.test(email)) {
      setEmailError('Please enter a valid email address.')
      return
    }
    setEmailError('')

    if (!consent) {
      setConsentError('Please agree to be contacted before joining the waitlist.')
      return
    }
    setConsentError('')
    setSubmitting(true)

    try {
      const docId = encodeEmailToDocId(email)
      await setDoc(doc(db, 'waitlist', docId), {
        email,
        country,
        signedUpAt: serverTimestamp(),
        consentGiven: true,
      })
      navigate('/waitlist/confirmed')
    } catch (unknownError: unknown) {
      const firebaseError = unknownError as { code?: string }
      if (firebaseError.code === 'permission-denied') {
        setAlreadyOnList(true)
      } else {
        throw unknownError
      }
    } finally {
      setSubmitting(false)
    }
  }

  function handleCountryOpenChange(open: boolean) {
    setCountryOpen(open)
    if (!open) setCountryQuery(country)
  }

  function selectCountry(value: string) {
    setCountry(value)
    setCountryQuery(value)
    setCountryOpen(false)
    countryInputRef.current?.focus()
  }

  function handleCountryQueryChange(value: string) {
    setCountryQuery(value)
    setCountryOpen(true)
    setHighlightedIndex(0)
  }

  function handleCountryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!countryOpen) {
        setCountryOpen(true)
        return
      }
      setHighlightedIndex(i => Math.min(i + 1, filteredCountries.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!countryOpen) {
        setCountryOpen(true)
        return
      }
      setHighlightedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (countryOpen && filteredCountries[highlightedIndex]) {
        e.preventDefault()
        selectCountry(filteredCountries[highlightedIndex])
      }
    } else if (e.key === 'Escape') {
      if (countryOpen) {
        e.preventDefault()
        handleCountryOpenChange(false)
      }
    }
  }

  return (
    <div className={`min-h-screen bg-white font-sans${embedded ? ' v2-shift' : ''}`}>
      {embedded ? null : <Header />}

      <main className="flex flex-col items-center px-4 py-20">
        <div className="w-full max-w-md text-center mb-8 pt-10">
          <h1 className="text-3xl font-bold text-text-primary mb-2">Join the waitlist</h1>
          <p className="text-text-secondary text-sm">
            Be the first to know when Ferro Maps launches in your area.
          </p>
        </div>

        <Card className="w-full max-w-md rounded-card">
          {alreadyOnList ? (
            <div className="flex flex-col items-center text-center gap-3 py-6">
              <CheckCircle2 className="w-8 h-8 text-ferro-grey-text" />
              <p className="text-sm font-medium text-text-primary">You're already on the list</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                type="email"
                label="Email"
                placeholder="you@example.com"
                value={email}
                onChange={e => {
                  setEmail(e.target.value)
                  if (emailError && EMAIL_PATTERN.test(e.target.value)) setEmailError('')
                }}
                required
                error={emailError}
                className="!rounded-md"
              />

              <div className="flex flex-col gap-1">
                <label htmlFor="country" className="text-sm font-medium text-gray-700">
                  Country
                </label>
                <Popover.Root open={countryOpen} onOpenChange={handleCountryOpenChange}>
                  <Popover.Anchor asChild>
                    <input
                      id="country"
                      ref={countryInputRef}
                      type="text"
                      role="combobox"
                      aria-expanded={countryOpen}
                      aria-controls="country-listbox"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        countryOpen && filteredCountries[highlightedIndex]
                          ? `country-option-${highlightedIndex}`
                          : undefined
                      }
                      autoComplete="off"
                      placeholder="Search for your country"
                      value={countryQuery}
                      onChange={e => handleCountryQueryChange(e.target.value)}
                      onFocus={() => setCountryOpen(true)}
                      onKeyDown={handleCountryKeyDown}
                      required
                      className="w-full px-3 py-2 text-sm rounded-md border border-gray-300 bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-ferro-primary focus:ring-offset-2"
                    />
                  </Popover.Anchor>

                  <Popover.Portal>
                    <Popover.Content
                      id="country-listbox"
                      role="listbox"
                      align="start"
                      sideOffset={4}
                      onOpenAutoFocus={e => e.preventDefault()}
                      onCloseAutoFocus={e => e.preventDefault()}
                      className="z-50 w-[var(--radix-popover-trigger-width)] max-h-60 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-md p-1 focus:outline-none"
                    >
                      {filteredCountries.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-400">No countries found</div>
                      ) : (
                        filteredCountries.map((c, i) => (
                          <button
                            key={c}
                            type="button"
                            id={`country-option-${i}`}
                            role="option"
                            aria-selected={c === country}
                            onMouseDown={e => e.preventDefault()}
                            onMouseEnter={() => setHighlightedIndex(i)}
                            onClick={() => selectCountry(c)}
                            className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
                              i === highlightedIndex
                                ? 'bg-ferro-tint text-ferro-primary'
                                : 'text-gray-700'
                            }`}
                          >
                            {c}
                          </button>
                        ))
                      )}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </div>

              <label className="flex items-start gap-2 bg-ferro-tint rounded-md p-3 text-xs text-text-secondary leading-relaxed">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={e => {
                    setConsent(e.target.checked)
                    if (e.target.checked) setConsentError('')
                  }}
                  className="mt-0.5 accent-ferro-primary"
                />
                <span>
                  I agree to be contacted about Ferro Maps and understand my data will be processed per the{' '}
                  <a href={embedded ? '/v2/privacy-policy' : '/privacy'} className="text-ferro-primary underline hover:no-underline">
                    Privacy Policy
                  </a>
                  . I can withdraw consent at any time.
                </span>
              </label>
              {consentError && <p className="text-xs text-red-500">{consentError}</p>}

              <Button type="submit" className="w-full mt-2" disabled={submitting}>
                {submitting ? 'Joining…' : 'Join waitlist'}
              </Button>
            </form>
          )}
        </Card>
      </main>

      {embedded ? null : <Footer />}
    </div>
  )
}
