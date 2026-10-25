import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { db } from './lib/firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'

const faqs = [
  { q: 'What is Ferro Maps?', a: 'Ferro Maps is a navigation for income app for gig economy drivers. It tells you where demand is highest in real time so you can position yourself smarter and earn more, before you drive there.' },
  { q: 'Which cities is Ferro Maps available in?', a: 'Ferro Maps is currently live in London. We are building towards expansion across the UK and internationally in later phases. If you are outside London, you can join our waitlist to be notified when we launch in your area.' },
  { q: 'What do the 7 categories mean?', a: "Ferro Maps hotspots falls into 7 categories, each with its own icon on the map. Venue covers high-footfall locations like hotels, museums, tourist attractions, stadiums, and nightclubs (nightclubs only show Thursday to Saturday). Event covers anything happening at a specific time, from concerts and plays to quiz nights. Flights reflects scheduled arrivals and departures at airports. Transport Disruption flags train or tube delays that push more people onto the road. Flight Disruption flags delayed or cancelled flights creating sudden demand at the airport. Hotspot Egg is a limited-time bonus opportunity added by drivers themselves. Parking highlights free parking nearby, also added by drivers"},
  { q: 'Does Ferro Maps replace my Uber or Bolt app?', a: 'NO. Ferro Maps works alongside your existing driver apps. You continue to accept jobs through Uber, Bolt, or whichever platform you use. Ferro Maps is the intelligence layer you open between trips to decide where to position yourself next.' },
  { q: 'How do I earn XP points?', a: 'You earn XP by completing gigs and engaging with hotspots, the more you use Ferro Maps to find and act on opportunities, the faster your XP builds. As your XP increases, you level up and unlock new rewards, including exclusive avatar skins and new ferro bird friends to add to your profile. Your current level and progress towards the next one are always visible from your profile screen.' },
]

const inputClass =
  'bg-white border border-border-default rounded-lg px-4 py-2 text-[12px] focus:ring-2 focus:ring-ferro-primary outline-none w-full'

export default function Contact() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState(false)
  const [openFaq, setOpenFaq] = useState<number | null>(3)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setSuccess(false)
    setError(false)

    try {
      await addDoc(collection(db, 'supportRequests'), {
        name,
        email,
        message,
        agreedToPolicy: agreed,
        submittedAt: serverTimestamp(),
        status: 'open',
        ticketNumber: Date.now(),
        subject: message.trim().slice(0, 60),
        replies: [],
      })

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
    <section id="contact" className="bg-white py-12 px-6">
      <div className="text-center mb-8">
        <p className="text-ferro-primary text-[11px] font-semibold tracking-widest uppercase mb-3">
          CONTACT
        </p>

        <h2 className="font-bold text-[30px] leading-tight text-neutral-900 mb-2">
          Got questions? We'll answer fast
        </h2>

        <p className="font-bold text-[20px] leading-tight text-neutral-700">
          Most drivers find what they need below. If not, drop us a line.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-6xl mx-auto px-0 md:px-10 items-stretch">

        {/* LEFT — Contact form */}
        <div className="bg-surface-brand-subtle rounded-lg p-6 h-full">
          <div className="flex items-center gap-3 mb-5">
            <span className="bg-ferro-primary text-white rounded-full px-5 py-1.5 text-[11px] font-semibold">
              Form
            </span>

            <span className="text-[11px] font-semibold text-neutral-900">
            </span>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-6">
              <div className="flex flex-col">
                <label className="text-[11px] font-bold text-neutral-900 mb-2">
                  Name
                </label>

                <input
                  type="text"
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={200}
                  className={`${inputClass} h-[38px]`}
                  required
                />
              </div>

              <div className="flex flex-col">
                <label className="text-[11px] font-bold text-neutral-900 mb-2">
                  Email
                </label>

                <input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={320}
                  className={`${inputClass} h-[38px]`}
                  required
                />
              </div>
            </div>

            <div className="flex flex-col">
              <label className="text-[11px] font-bold text-neutral-900 mb-2">
                Your message
              </label>

              <textarea
                placeholder="Tell us as much as you can."
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={5000}
                className={`${inputClass} resize-none h-[120px]`}
                required
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-[11px] text-neutral-700">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                required
                className="w-3 h-3 accent-ferro-primary"
              />

              <span>
                I agree to the{' '}
                <a href="#" className="font-bold text-neutral-900 no-underline">
                  Privacy Policy
                </a>
              </span>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-ferro-primary text-white rounded-button py-3 text-[12px] hover:bg-ferro-deep transition-colors duration-fast disabled:opacity-50"
            >
              {loading ? 'Sending…' : 'Submit'}
            </button>

            {success && (
              <p className="text-[12px] text-color-success font-medium">
                Message sent! We'll be in touch soon.
              </p>
            )}

            {error && (
              <p className="text-[12px] text-color-danger font-medium">
                Something went wrong. Please try support@ferromaps.com
              </p>
            )}
          </form>
        </div>

        {/* RIGHT — FAQ accordion */}
        <div className="h-full flex flex-col">
          <h3 className="font-bold text-[13px] text-neutral-900 mb-3">
            Frequently Asked Questions
          </h3>

          {faqs.map((faq, i) => {
            const isOpen = openFaq === i

            return (
            <div
              key={i}
              className={`border border-border-default rounded-lg px-4 py-4 cursor-pointer flex-1 flex flex-col justify-center ${
                i < faqs.length - 1 ? 'mb-3' : ''
              } ${isOpen ? 'bg-surface-brand-subtle' : 'bg-white'}`}
              style={{ boxShadow: '0 2px 4px rgba(15,22,38,0.04), 0 4px 12px rgba(15,22,38,0.08)' }}
              onClick={() => setOpenFaq(isOpen ? null : i)}
            >
                <div className="flex justify-between items-center">
                  <span className="font-bold text-[12px] text-neutral-900">
                    {faq.q}
                  </span>

                  <div className="w-5 h-5 rounded-full border-2 border-ferro-primary flex items-center justify-center flex-shrink-0">
                    <ChevronDown
                      size={12}
                      className={`text-ferro-primary transition-transform duration-fast ${
                        isOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </div>
                </div>

                {isOpen && (
                  <p className="text-[11px] text-neutral-700 mt-3">
                    {faq.a}
                  </p>
                )}
              </div>
            )
          })}
        </div>

      </div>
    </section>
  )
}