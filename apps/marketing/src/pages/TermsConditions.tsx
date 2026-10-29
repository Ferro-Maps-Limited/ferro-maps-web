import Header from '../Header'
import Footer from '../Footer'

const tocLinks = [
  { id: 'introduction-and-acceptance', label: '1. Introduction and acceptance' },
  { id: 'eligibility', label: '2. Eligibility' },
  { id: 'your-account', label: '3. Your account' },
  { id: 'description-of-the-service', label: '4. Description of the Service' },
  { id: 'ferro-points', label: '5. Ferro points' },
  { id: 'subscriptions-and-payments', label: '6. Subscriptions and payments' },
  { id: 'advertising', label: '7. Advertising' },
  { id: 'acceptable-use', label: '8. Acceptable use' },
  { id: 'driving-safety', label: '9. Driving safety' },
  { id: 'intellectual-property', label: '10. Intellectual property' },
  { id: 'third-party-services', label: '11. Third-party services and content' },
  { id: 'disclaimers', label: '12. Disclaimers' },
  { id: 'limitation-of-liability', label: '13. Limitation of liability' },
  { id: 'suspension-and-termination', label: '14. Suspension and termination' },
  { id: 'governing-law-and-disputes', label: '15. Governing law and disputes' },
  { id: 'general-provisions', label: '16. General provisions' },
  { id: 'apple-and-google', label: '17. Apple App Store and Google Play Store' },
  { id: 'open-source-licences', label: '18. Open source and third-party licences' },
  { id: 'beta-testing', label: '19. Beta testing' },
  { id: 'contact-us', label: '20. Contact us' },
]


export default function TermsConditions({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={embedded ? 'v2-prose' : 'min-h-screen bg-white text-text-primary font-nunito'}>
      {embedded ? null : <Header />}

      {/* Hero */}
      <section className="pt-32 pb-12 px-6 md:px-8">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-ferro-primary text-sm font-semibold uppercase tracking-widest mb-4">LEGAL</p>
          <h1 className="text-4xl md:text-5xl font-bold text-text-primary mb-4">Terms and Conditions</h1>
          <p className="text-text-tertiary text-base mb-10">Last reviewed: June 2026</p>
          <div className="bg-ferro-tint rounded-xl p-6 text-left">
            <p className="font-semibold text-text-primary mb-2">In plain English</p>
            <p className="text-text-secondary leading-relaxed">
              By using Ferro Maps you agree to use the app safely and lawfully, and you confirm you're
              at least 18. Ferro Maps shows you where demand is highest but doesn't guarantee earnings,
              isn't a ride-hailing app, and isn't your employer. Never interact with the app while
              driving. Ferro points have no cash value and are forfeited if your account is deleted or
              terminated for breaking these rules. Phase 1 is free and provided as a beta — features
              may change. These Terms are governed by the laws of England and Wales.
            </p>
          </div>
        </div>
      </section>

      {/* Two-column layout */}
      <div className="max-w-6xl mx-auto px-6 md:px-8 pb-24">
        <div className="flex flex-col lg:flex-row gap-12">

          {/* Table of contents */}
          <aside className="lg:w-56 flex-shrink-0">
            <div className="sticky top-24">
              <p className="text-sm font-semibold text-text-primary mb-4">Contents</p>
              <nav className="flex flex-col gap-0.5">
                {tocLinks.map(({ id, label }) => (
                  <a
                    key={id}
                    href={`#${id}`}
                    className="text-sm text-ferro-primary py-1 leading-snug hover:underline transition-colors duration-fast"
                  >
                    {label}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          {/* Terms content */}
          <article className="flex-1 min-w-0">

            {/* Section 1 */}
            <section className="mb-12">
              <h2 id="introduction-and-acceptance" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                1. Introduction and acceptance
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                These Terms and Conditions ("Terms") form a legally binding agreement between you
                ("you", "your", "the User", "the Driver") and Ferro Maps Ltd ("Ferro Maps", "the
                Company", "we", "us", "our"), a company registered in England and Wales with company
                number 17197682, whose registered office is at Icon Tower, North Acton, London W3 6FD.
              </p>
              <p className="text-text-secondary leading-relaxed mb-4">
                These Terms govern your use of the Ferro Maps mobile application (iOS and Android), the
                Ferro Maps marketing website (ferromaps.com), and any related services, features,
                content, or functionality we provide (together, the "Service").
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                1.1 How you accept these Terms
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                By creating an account, downloading the app, or using any part of the Service, you
                confirm that you have read, understood, and agree to be bound by these Terms and our
                Privacy Policy. If you do not agree, you must not use the Service.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                1.2 Changes to these Terms
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                We may update these Terms from time to time. When we make material changes, we will
                notify you via an in-app notification or push notification at least 14 days before the
                changes take effect. Your continued use of the Service after the effective date
                constitutes acceptance of the updated Terms.
              </p>
              <p className="text-text-secondary leading-relaxed mb-4">
                If you do not agree to any material change, you may stop using the Service and delete
                your account before the change takes effect. We will keep previous versions of these
                Terms available on request.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                1.3 Additional terms
              </h3>
              <p className="text-text-secondary leading-relaxed">
                Certain features of the Service may be subject to additional terms (for example, beta
                testing terms, promotional rules, or subscription-specific terms). Where additional
                terms apply, we will present them to you before you use the relevant feature. In the
                event of a conflict between these Terms and any additional terms, the additional terms
                prevail for the feature in question.
              </p>
            </section>

            {/* Section 2 */}
            <section className="mb-12">
              <h2 id="eligibility" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                2. Eligibility
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                To use the Service, you must:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Be at least 18 years of age.</li>
                <li>Have the legal capacity to enter into a binding agreement under English law.</li>
                <li>
                  Be a private hire, gig economy, or delivery driver, or have a legitimate
                  professional interest in demand intelligence tools.
                </li>
                <li>Provide accurate and truthful information during registration.</li>
              </ul>
              <p className="text-text-secondary leading-relaxed">
                You do not need to hold a specific licence (such as a PCO licence) to create an account
                in Phase 1 (beta), but the Service is designed for licensed professional drivers. Ferro
                Maps does not verify your licensing or employment status and does not act as your
                employer, fleet operator, or ride-hailing platform.
              </p>
            </section>

            {/* Section 3 */}
            <section className="mb-12">
              <h2 id="your-account" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                3. Your account
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.1 Registration
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                You register by verifying your mobile phone number via a one-time passcode (OTP). You
                may optionally add an email address as a backup sign-in method. You are responsible for
                the accuracy of the information you provide.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.2 Account security
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                You are responsible for all activity that occurs under your account. You must:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Keep your phone number and any sign-in credentials secure.</li>
                <li>
                  Notify us immediately if you believe your account has been accessed without your
                  authorisation.
                </li>
                <li>Not share your account with any other person.</li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.3 Single-device policy
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Your account may only be active on one device at a time. If you sign in on a new
                device, your session on the previous device will be terminated after you confirm the
                device switch via push notification or OTP re-verification. This policy exists to
                prevent account sharing and subscription abuse.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.4 Account deletion
              </h3>
              <p className="text-text-secondary leading-relaxed">
                You may delete your account at any time through the app settings or by contacting us at
                the email address in Section 20. On deletion, we will remove your personal data in
                accordance with our Privacy Policy. Certain data (such as anonymised analytics and
                legally required records) may be retained as described in the Privacy Policy.
              </p>
            </section>

            {/* Section 4 */}
            <section className="mb-12">
              <h2 id="description-of-the-service" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                4. Description of the Service
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                Ferro Maps is a demand intelligence tool for gig economy drivers. The Service provides:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  A real-time map displaying demand hotspots in your area, scored and categorised into
                  three tiers: Good, Great, and Flawless.
                </li>
                <li>
                  Proximity-based push notifications alerting you to high-value Flawless hotspots
                  within 3km of your location.
                </li>
                <li>
                  A gamification system ("Ferro points" or "Ferros") that rewards you for physically
                  visiting hotspot locations within their active countdown window.
                </li>
                <li>
                  A driver profile with avatar customisation, Ferro balance display, and earnings
                  history.
                </li>
                <li>
                  A leaderboard showing the top Ferro earners among the current driver cohort,
                  identified by display name and avatar only.
                </li>
                <li>A Tesla Supercharger location overlay on the map (Phase 1).</li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                4.1 What the Service is not
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">Ferro Maps is not:</p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  A ride-hailing, ride-sharing, or ride-booking platform. We do not connect you with
                  passengers, accept ride requests, process fares, or handle payments between you and
                  passengers.
                </li>
                <li>
                  A navigation or turn-by-turn directions app. We show you where demand is; how you
                  get there is up to you and your preferred navigation app.
                </li>
                <li>
                  An employer, fleet operator, or labour provider. Your relationship with Ferro Maps
                  is that of a user of a software tool. Nothing in these Terms creates an employment,
                  agency, partnership, or joint venture relationship between you and Ferro Maps.
                </li>
                <li>
                  A guarantee of earnings. Hotspot data is based on publicly available event
                  information and rule-based scoring algorithms. Actual demand may differ from
                  predicted demand. We do not guarantee that visiting a hotspot will result in a ride,
                  delivery, or any particular level of earnings.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                4.2 Hotspot data and accuracy
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                Hotspot data is sourced from publicly available event information (including Eventbrite,
                Google Places, and Skiddle) and scored by a rule-based algorithm. We make reasonable
                efforts to ensure hotspot data is timely and accurate, but we do not warrant that:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Every real-world demand opportunity will appear as a hotspot.</li>
                <li>Hotspot tiers will precisely reflect actual demand levels.</li>
                <li>Event details (name, time, attendance) will always be correct.</li>
                <li>Hotspots will be available in all areas at all times.</li>
              </ul>
              <p className="text-text-secondary leading-relaxed">
                You should always exercise your own professional judgment when deciding where to
                position your vehicle. Ferro Maps is a supplementary intelligence tool, not a
                substitute for your experience and situational awareness.
              </p>
            </section>

            {/* Section 5 */}
            <section className="mb-12">
              <h2 id="ferro-points" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                5. Ferro points
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.1 Earning Ferros
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                You earn Ferro points ("Ferros") by physically visiting hotspot locations while the
                hotspot is active (i.e. before its countdown expires). The app detects proximity when
                you are within 200 metres of a hotspot's geographic centre. Ferros are awarded
                automatically via an atomic transaction and recorded in your earnings history.
              </p>
              <p className="text-text-secondary leading-relaxed mb-4">
                The number of Ferros awarded per visit depends on the hotspot tier. Tier values may be
                adjusted by Ferro Maps from time to time.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.2 Ferro balance
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Your current Ferro balance is displayed on your profile screen and on the map view.
                Ferro balances are personal to your account and cannot be transferred to another user.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.3 No monetary value
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Ferros have no monetary value and cannot be exchanged for cash, sold, or traded outside
                the Ferro Maps platform. They are a gamification feature of the Service, not a
                currency, cryptocurrency, loyalty point, or financial instrument.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.4 Points-to-subscription redemption (Phase 2)
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                In a future update, drivers who accumulate 100 or more Ferros may redeem them for a
                one-month Ferro Maps Premium subscription. Redemption deducts 100 Ferros atomically
                from your balance. The details, availability, and terms of redemption will be
                communicated at launch and may be subject to additional terms.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.5 Adjustment and forfeiture
              </h3>
              <p className="text-text-secondary leading-relaxed">
                We reserve the right to adjust your Ferro balance if we detect that Ferros were earned
                through fraud, manipulation, GPS spoofing, automated tools, or any violation of these
                Terms. In cases of serious abuse, your account may be suspended or terminated under
                Section 14.
              </p>
              <p className="text-text-secondary leading-relaxed mt-3">
                If you delete your account, your Ferro balance is forfeited and cannot be recovered.
              </p>
            </section>

            {/* Section 6 */}
            <section className="mb-12">
              <h2 id="subscriptions-and-payments" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                6. Subscriptions and payments (Phase 2)
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                Phase 1 of the Service is entirely free. This section applies when subscriptions are
                introduced in Phase 2.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.1 Ferro Maps Premium
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Ferro Maps Premium is a paid subscription tier offering additional features (such as
                ad-free experience, full hotspot history, and advanced filtering). The subscription
                price, billing frequency, and included features will be disclosed clearly before
                purchase.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.2 Billing
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Subscriptions are purchased and managed through the Apple App Store (for iOS) or Google
                Play Store (for Android). Ferro Maps does not collect or process payment card
                information directly. All billing, renewals, refunds, and cancellations are handled by
                Apple or Google in accordance with their respective terms.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.3 Auto-renewal
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Subscriptions auto-renew at the end of each billing period unless you cancel before the
                renewal date. You can manage and cancel your subscription through your Apple ID or
                Google Play account settings.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.4 Refunds
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Refund requests should be directed to Apple or Google, as they process all payments. We
                do not handle refunds directly, but we will cooperate with Apple or Google where
                required.
              </p>
              <p className="text-text-secondary leading-relaxed mb-4">
                Nothing in this section affects your statutory rights under the Consumer Rights Act
                2015 or the Consumer Contracts (Information, Cancellation and Additional Charges)
                Regulations 2013.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.5 Price changes
              </h3>
              <p className="text-text-secondary leading-relaxed">
                We may change subscription prices from time to time. We will give you at least 30 days'
                notice of any price increase. The new price will apply from your next renewal date after
                the notice period. If you do not agree to a price increase, you may cancel before it
                takes effect.
              </p>
            </section>

            {/* Section 7 */}
            <section className="mb-12">
              <h2 id="advertising" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                7. Advertising (Phase 3)
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                In a future phase, Ferro Maps may display contextual advertising to drivers on the free
                tier. If and when advertising is introduced:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  Advertisements will be non-intrusive banner placements that do not overlap with
                  hotspot pins, countdowns, or interactive map elements.
                </li>
                <li>
                  Advertising categories will be curated and limited to gig-worker-relevant products
                  and services (such as PCO insurance, vehicle servicing, EV charging, and driver
                  financial services). Generic consumer brand advertising is prohibited.
                </li>
                <li>Premium subscribers will not see advertisements.</li>
                <li>
                  We will not use your personal data (including location) for behavioural or targeted
                  advertising. Any advertising served will be contextual, not personalised.
                </li>
              </ul>
              <p className="text-text-secondary leading-relaxed">
                This section will be updated with specific advertising terms before any advertising is
                introduced.
              </p>
            </section>

            {/* Section 8 */}
            <section className="mb-12">
              <h2 id="acceptable-use" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                8. Acceptable use
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                You agree to use the Service responsibly and lawfully. You must not:
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                8.1 Prohibited conduct
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  Use the Service for any unlawful purpose or in violation of any applicable law or
                  regulation.
                </li>
                <li>
                  Impersonate any person or entity, or misrepresent your affiliation with any person
                  or entity.
                </li>
                <li>
                  Create multiple accounts for the same person, or create accounts on behalf of others
                  without their consent.
                </li>
                <li>
                  Share your account credentials with any other person or allow another person to use
                  your account.
                </li>
                <li>
                  Use GPS spoofing, location falsification, mock location apps, or any other means to
                  manipulate your apparent geographic position to earn Ferros fraudulently.
                </li>
                <li>
                  Use automated tools, bots, scripts, or crawlers to interact with the Service.
                </li>
                <li>
                  Attempt to access, probe, or test the vulnerability of the Service or any related
                  system or network, or breach any security or authentication measures.
                </li>
                <li>
                  Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source
                  code of the app, except to the extent that such restriction is expressly prohibited
                  by applicable law.
                </li>
                <li>
                  Interfere with, disrupt, or place an unreasonable load on the Service or the
                  servers, networks, or infrastructure supporting it.
                </li>
                <li>
                  Scrape, harvest, or extract data from the Service for any purpose not expressly
                  permitted by these Terms.
                </li>
                <li>
                  Use the Service while driving in a manner that distracts you from safe operation of
                  your vehicle (see Section 9).
                </li>
                <li>
                  Upload, transmit, or share any content that is defamatory, obscene, harassing,
                  threatening, or otherwise objectionable.
                </li>
                <li>
                  Use the leaderboard, share feature, or any community-facing feature to harass,
                  abuse, or demean other users.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                8.2 Consequences of violation
              </h3>
              <p className="text-text-secondary leading-relaxed">
                If we reasonably believe you have violated this section, we may, at our sole
                discretion: issue a warning; temporarily suspend your account; permanently terminate
                your account and forfeit your Ferro balance; or take any other action we consider
                necessary to protect the Service, other users, or the Company. Serious violations may
                be reported to law enforcement.
              </p>
            </section>

            {/* Section 9 */}
            <section className="mb-12">
              <h2 id="driving-safety" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                9. Driving safety
              </h2>

              <div className="bg-ferro-tint border-l-4 border-ferro-signal rounded-lg p-4 mb-6">
                <p className="font-bold text-ferro-ink mb-1">Important</p>
                <p className="text-sm text-text-secondary">
                  You must never interact with the Ferro Maps app while your vehicle is in motion.
                  Your safety and the safety of other road users is always more important than any
                  hotspot, Ferro point, or notification.
                </p>
              </div>

              <p className="text-text-secondary leading-relaxed mb-3">
                Ferro Maps is designed to be consulted before you start driving or while safely parked.
                The map view is designed to be glanceable from a car dock, but you must not:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Tap, swipe, or type on the app while driving.</li>
                <li>
                  Hold your phone while driving to use the app (this is a criminal offence under UK
                  law).
                </li>
                <li>
                  Make driving decisions (route changes, sudden stops, U-turns) based solely on a
                  hotspot notification while in motion.
                </li>
              </ul>
              <p className="text-text-secondary leading-relaxed mb-4">
                Ferro Maps is not a navigation app and does not provide turn-by-turn directions. You
                are solely responsible for operating your vehicle safely and in compliance with the
                Highway Code, the Road Traffic Act 1988, and all applicable road traffic laws.
              </p>
              <p className="text-text-secondary leading-relaxed">
                Ferro Maps Ltd accepts no liability for any accident, injury, fine, penalty, or loss
                arising from your use of the app while driving.
              </p>
            </section>

            {/* Section 10 */}
            <section className="mb-12">
              <h2 id="intellectual-property" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                10. Intellectual property
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                10.1 Our rights
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                All intellectual property rights in the Service — including the app, website, software,
                algorithms, designs, logos, trademarks (including the Ferro Maps name and bird logo),
                branding, content, and documentation — are owned by Ferro Maps Ltd or its licensors.
                Nothing in these Terms grants you any right, title, or interest in any intellectual
                property of Ferro Maps except the limited licence in Section 10.3.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                10.2 Hotspot data
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Hotspot data is generated by Ferro Maps using publicly available event data processed
                through our proprietary scoring algorithms. The raw event data may originate from
                third-party sources, but the scored, tiered, and geo-located hotspot data set is a
                product of Ferro Maps and is protected as a database right and/or compilation under UK
                and EU law.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                10.3 Licence to use
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                Subject to these Terms, we grant you a limited, non-exclusive, non-transferable,
                revocable licence to download, install, and use the app on a single device that you own
                or control, solely for your personal, non-commercial use as a gig economy driver. This
                licence does not include the right to:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Sublicense, sell, lease, or distribute the app or any part of it.</li>
                <li>Modify, adapt, or create derivative works based on the app.</li>
                <li>
                  Use the app or any data obtained through it for commercial data aggregation, resale,
                  or competitive intelligence.
                </li>
              </ul>
              <p className="text-text-secondary leading-relaxed mb-4">
                This licence terminates automatically if you breach these Terms.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                10.4 Your content
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                You retain ownership of any content you provide to us (for example, your display name
                and avatar selections). By providing content, you grant us a worldwide, royalty-free,
                non-exclusive licence to use, display, and store that content solely for the purpose of
                operating and improving the Service.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                10.5 Feedback
              </h3>
              <p className="text-text-secondary leading-relaxed">
                If you provide us with suggestions, ideas, or feedback about the Service, you grant us
                an unrestricted, irrevocable, royalty-free licence to use that feedback for any
                purpose, including to improve the Service. We are not obligated to implement any
                feedback or to compensate you for it.
              </p>
            </section>

            {/* Section 11 */}
            <section className="mb-12">
              <h2 id="third-party-services" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                11. Third-party services and content
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                The Service may contain links to or integrations with third-party services, including:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  Apple App Store and Google Play Store (for app distribution and subscription
                  billing).
                </li>
                <li>
                  Tesla Supercharger location data (displayed as an overlay on the map).
                </li>
                <li>
                  Event data from third-party APIs (Eventbrite, Google Places, Skiddle).
                </li>
              </ul>
              <p className="text-text-secondary leading-relaxed mb-4">
                We do not control and are not responsible for the content, privacy practices, or
                availability of third-party services. Your use of third-party services is governed by
                their respective terms and privacy policies. We encourage you to review them.
              </p>
              <p className="text-text-secondary leading-relaxed">
                Inclusion of third-party content or links does not imply endorsement, sponsorship, or
                affiliation.
              </p>
            </section>

            {/* Section 12 */}
            <section className="mb-12">
              <h2 id="disclaimers" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                12. Disclaimers
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                12.1 Service provided "as is"
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                To the maximum extent permitted by applicable law, the Service is provided on an "as
                is" and "as available" basis, without warranties of any kind, whether express, implied,
                or statutory, including but not limited to implied warranties of merchantability,
                fitness for a particular purpose, and non-infringement.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                12.2 No guarantee of availability
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                We do not guarantee that the Service will be available at all times, uninterrupted,
                error-free, or free from harmful components. The Service may operate in a degraded mode
                (map visible, no hotspots) during periods of server unavailability.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                12.3 No guarantee of earnings
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Ferro Maps provides demand intelligence based on publicly available data and rule-based
                algorithms. We make no representation or warranty that using the Service will result in
                any particular level of ride requests, deliveries, fares, or earnings. Your earnings
                depend on factors entirely outside our control, including market conditions, platform
                algorithms (Uber, Bolt, etc.), competition, weather, and your own decisions.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                12.4 Beta services
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                During Phase 1 (TestFlight / beta), the Service is provided as a pre-release product.
                Beta features may contain bugs, may be incomplete, and may change significantly before
                general release. By participating in the beta, you acknowledge and accept these risks.
                Beta participation does not guarantee future access to the Service.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                12.5 Consumer rights
              </h3>
              <p className="text-text-secondary leading-relaxed">
                Nothing in these Terms excludes or limits any rights you have under the Consumer Rights
                Act 2015, the Consumer Contracts (Information, Cancellation and Additional Charges)
                Regulations 2013, or any other mandatory consumer protection law that cannot be
                excluded or limited by contract.
              </p>
            </section>

            {/* Section 13 */}
            <section className="mb-12">
              <h2 id="limitation-of-liability" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                13. Limitation of liability
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                13.1 Exclusions we cannot make
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                Nothing in these Terms excludes or limits our liability for:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Death or personal injury caused by our negligence.</li>
                <li>Fraud or fraudulent misrepresentation.</li>
                <li>
                  Any liability that cannot be excluded or limited under applicable law, including the
                  Consumer Rights Act 2015.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                13.2 Exclusion of indirect losses
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Subject to Section 13.1, we shall not be liable to you for any indirect, incidental,
                special, consequential, or punitive damages, or for any loss of profits, revenue, data,
                business, goodwill, or anticipated savings, whether arising in contract, tort
                (including negligence), breach of statutory duty, or otherwise, even if we have been
                advised of the possibility of such damages.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                13.3 Cap on liability
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Subject to Section 13.1, our total aggregate liability to you for all claims arising
                out of or relating to these Terms or the Service shall not exceed the greater of: (a)
                the total amount you have paid to us in subscription fees during the 12 months
                immediately preceding the claim; or (b) fifty pounds sterling (GBP 50.00).
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                13.4 Your liability
              </h3>
              <p className="text-text-secondary leading-relaxed">
                You are solely responsible for your use of the Service, including any decisions you
                make about where to position your vehicle, how you drive, and how you interact with
                passengers, platform operators, or other road users. You agree to indemnify and hold
                harmless Ferro Maps Ltd, its directors, employees, and agents from and against any
                claims, losses, damages, liabilities, costs, and expenses (including legal fees)
                arising out of or related to your breach of these Terms or your use of the Service.
              </p>
            </section>

            {/* Section 14 */}
            <section className="mb-12">
              <h2 id="suspension-and-termination" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                14. Suspension and termination
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                14.1 By you
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                You may stop using the Service at any time. To permanently close your account, use the
                account deletion feature in the app settings or contact us at the address in Section
                20. If you have an active subscription, cancellation of the subscription is separate
                from account deletion — see Section 6.3.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                14.2 By us
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                We may suspend or terminate your account and access to the Service, with or without
                notice, if:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  You breach these Terms (including the acceptable use policy in Section 8).
                </li>
                <li>We reasonably believe your account has been compromised.</li>
                <li>We are required to do so by law, regulation, or court order.</li>
                <li>We cease to offer the Service (see Section 14.4).</li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                14.3 Effect of termination
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                On termination of your account:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Your licence to use the app (Section 10.3) terminates immediately.</li>
                <li>Your Ferro balance is forfeited and cannot be recovered.</li>
                <li>
                  Your personal data will be handled in accordance with our Privacy Policy.
                </li>
                <li>
                  Any accrued rights or obligations (including Sections 10, 12, 13, 15, and 16)
                  survive termination.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                14.4 Discontinuation of the Service
              </h3>
              <p className="text-text-secondary leading-relaxed">
                We may discontinue the Service (in whole or in part) at any time by giving you at
                least 30 days' notice. If you have an active paid subscription at the time of
                discontinuation, we will provide a pro-rata refund for any unused portion of your
                subscription period.
              </p>
            </section>

            {/* Section 15 */}
            <section className="mb-12">
              <h2 id="governing-law-and-disputes" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                15. Governing law and disputes
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                15.1 Governing law
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                These Terms are governed by and construed in accordance with the laws of England and
                Wales.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                15.2 Jurisdiction
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Any disputes arising out of or in connection with these Terms shall be subject to the
                exclusive jurisdiction of the courts of England and Wales. If you are a consumer
                resident in the United Kingdom, nothing in this section affects your right to bring
                proceedings in your local courts.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                15.3 Informal resolution
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Before bringing any formal claim, we encourage you to contact us first to try to
                resolve the issue informally. Most issues can be resolved quickly and without the cost
                and stress of formal proceedings.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                15.4 Alternative dispute resolution
              </h3>
              <p className="text-text-secondary leading-relaxed">
                If we cannot resolve a dispute informally, you may be entitled to refer the matter to
                an alternative dispute resolution (ADR) provider. We will provide details of an
                approved ADR provider when relevant. You may also contact your local Citizens Advice
                Bureau or Trading Standards office for guidance.
              </p>
            </section>

            {/* Section 16 */}
            <section className="mb-12">
              <h2 id="general-provisions" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                16. General provisions
              </h2>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.1 Entire agreement
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                These Terms, together with our Privacy Policy and any additional terms for specific
                features, constitute the entire agreement between you and Ferro Maps relating to the
                Service.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.2 Severability
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                If any provision of these Terms is found to be invalid, illegal, or unenforceable by a
                court of competent jurisdiction, that provision shall be deemed modified to the minimum
                extent necessary to make it enforceable. The remaining provisions shall continue in
                full force and effect.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.3 Waiver
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                No failure or delay by us in exercising any right or remedy under these Terms shall
                operate as a waiver of that right or remedy. A waiver of one breach does not constitute
                a waiver of any subsequent breach.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.4 Assignment
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                You may not assign or transfer your rights or obligations under these Terms without our
                prior written consent. We may assign our rights and obligations under these Terms to a
                successor entity in connection with a merger, acquisition, or sale of all or
                substantially all of our assets, provided that the assignee agrees to be bound by these
                Terms.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.5 No third-party rights
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                These Terms do not confer any rights on any third party under the Contracts (Rights of
                Third Parties) Act 1999.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.6 Force majeure
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                We shall not be liable for any failure or delay in performing our obligations under
                these Terms to the extent that such failure or delay results from circumstances beyond
                our reasonable control, including natural disasters, pandemic, war, terrorism, riots,
                government action, power failure, internet or telecommunications failure, or acts of
                third parties.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                16.7 Notices
              </h3>
              <p className="text-text-secondary leading-relaxed">
                We may give you notice under these Terms by in-app notification, push notification, or
                email to the address associated with your account. You may give us notice by email to
                the address in Section 20.
              </p>
            </section>

            {/* Section 17 */}
            <section className="mb-12">
              <h2 id="apple-and-google" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                17. Apple App Store and Google Play Store
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                If you download the app from the Apple App Store or Google Play Store, the following
                additional terms apply:
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                17.1 Apple
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  These Terms are between you and Ferro Maps Ltd, not Apple Inc. Apple is not a party
                  to these Terms.
                </li>
                <li>
                  Apple has no obligation to provide maintenance, support, warranty, or other services
                  for the app.
                </li>
                <li>
                  In the event of a failure of the app to conform to any applicable warranty, you may
                  notify Apple and Apple will refund the purchase price (if any). To the maximum
                  extent permitted by law, Apple has no other warranty obligation with respect to the
                  app.
                </li>
                <li>
                  Apple is not responsible for any claims relating to the app, including product
                  liability, consumer protection, intellectual property, or regulatory compliance
                  claims.
                </li>
                <li>
                  Apple and its subsidiaries are third-party beneficiaries of these Terms. On your
                  acceptance of these Terms, Apple has the right to enforce them against you as a
                  third-party beneficiary.
                </li>
                <li>
                  You must comply with any applicable third-party terms when using the app (for
                  example, your wireless data plan terms).
                </li>
                <li>
                  You represent and warrant that you are not located in a country subject to a U.S.
                  Government embargo, or designated as a "terrorist supporting" country, and you are
                  not listed on any U.S. Government list of prohibited or restricted parties.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                17.2 Google
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>
                  These Terms are between you and Ferro Maps Ltd, not Google LLC.
                </li>
                <li>Google is not responsible for the app or its content.</li>
                <li>
                  Your use of the app downloaded from Google Play is also subject to the Google Play
                  Terms of Service.
                </li>
              </ul>
            </section>

            {/* Section 18 */}
            <section className="mb-12">
              <h2 id="open-source-licences" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                18. Open source and third-party licences
              </h2>
              <p className="text-text-secondary leading-relaxed">
                The app may include open source software components. A list of open source licences is
                available within the app settings. Your use of open source components is subject to the
                terms of their respective licences, which are incorporated by reference.
              </p>
            </section>

            {/* Section 19 */}
            <section className="mb-12">
              <h2 id="beta-testing" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                19. Beta testing (Phase 1)
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                This section applies during the Phase 1 TestFlight and internal beta period.
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  The beta is available by invitation only to selected Faber Motors drivers and other
                  users invited by Ferro Maps.
                </li>
                <li>
                  The beta Service is provided free of charge and "as is", with no guarantees of
                  uptime, feature completeness, or data persistence.
                </li>
                <li>
                  We may reset data (including Ferro balances) at any time during the beta without
                  notice.
                </li>
                <li>Beta features may be modified, suspended, or removed at any time.</li>
                <li>
                  By participating, you agree to provide reasonable feedback when requested and to
                  report bugs through the channels we provide (TestFlight feedback, Slack, or email).
                </li>
                <li>
                  Your participation in the beta does not guarantee access to the full commercial
                  release.
                </li>
                <li>
                  Confidentiality: during the beta, the app and its features are confidential. You
                  must not share screenshots, recordings, or descriptions of beta features with anyone
                  outside the beta group without our prior written consent.
                </li>
              </ul>
            </section>

            {/* Section 20 */}
            <section className="mb-12">
              <h2 id="contact-us" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                20. Contact us
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                If you have any questions about these Terms, or if you need to contact us for any
                reason, you can reach us at:
              </p>
              <div className="bg-neutral-50 rounded-xl p-6 text-text-secondary leading-relaxed space-y-1">
                <p className="font-semibold text-text-primary">Ferro Maps Ltd</p>
                <p>Email: admin@ferromaps.com </p>
                <p>Post: Icon Tower, North Acton, London W3 6FD</p>
                <p>Company number: 17197682</p>
              </div>
              <p className="text-text-secondary leading-relaxed mt-4">
                For data protection queries specifically, please see the contact details in our Privacy
                Policy.
              </p>
            </section>

          </article>
        </div>
      </div>

      {embedded ? null : <Footer />}
    </div>
  )
}
