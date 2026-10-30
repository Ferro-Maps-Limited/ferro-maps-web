import Header from '../Header'
import Footer from '../Footer'

const tocLinks = [
  { id: 'who-we-are', label: '1. Who we are' },
  { id: 'what-this-policy-covers', label: '2. What this policy covers' },
  { id: 'data-we-collect', label: '3. Data we collect' },
  { id: 'how-we-use-your-data', label: '4. How we use your data' },
  { id: 'how-we-handle-your-location', label: '5. How we handle your location data' },
  { id: 'who-we-share-with', label: '6. Who we share your data with' },
  { id: 'where-your-data-is-stored', label: '7. Where your data is stored' },
  { id: 'how-long-we-keep', label: '8. How long we keep your data' },
  { id: 'how-we-protect', label: '9. How we protect your data' },
  { id: 'your-rights', label: '10. Your rights' },
  { id: 'childrens-privacy', label: "11. Children's privacy" },
  { id: 'cookies-and-tracking', label: '12. Cookies and website tracking' },
  { id: 'third-party-links', label: '13. Third-party links' },
  { id: 'changes-to-this-policy', label: '14. Changes to this policy' },
  { id: 'how-to-contact-us', label: '15. How to contact us' },
]

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto my-5 rounded-lg border border-border-default">
      <table className="w-full text-sm">
        {headers.length > 0 && (
          <thead>
            <tr className="bg-neutral-50 border-b border-border-default">
              {headers.map((h, i) => (
                <th key={i} className="text-left px-4 py-3 text-text-secondary font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border-default last:border-b-0">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-4 py-3 align-top ${
                    headers.length === 0 && ci === 0
                      ? 'font-medium text-text-secondary w-52 whitespace-nowrap'
                      : 'text-text-primary'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function PrivacyPolicy({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={embedded ? 'v2-prose' : 'min-h-screen bg-white text-text-primary font-nunito'}>
      {embedded ? null : <Header />}

      {/* Hero */}
      <section className="pt-32 pb-12 px-6 md:px-8">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-ferro-primary text-sm font-semibold uppercase tracking-widest mb-4">LEGAL</p>
          <h1 className="text-4xl md:text-5xl font-bold text-text-primary mb-4">Privacy Policy</h1>
          <p className="text-text-tertiary text-base mb-10">Last reviewed: June 2026</p>
          <div className="bg-ferro-tint rounded-xl p-6 text-left">
            <p className="font-semibold text-text-primary mb-2">In plain English</p>
            <p className="text-text-secondary leading-relaxed">
              Ferro Maps collects your phone number, display name, and GPS location to show you demand
              hotspots and award Ferro points. Your location is automatically deleted within 24 hours.
              We never sell your data. All core data is stored in London. You can delete your account
              and all your data at any time from the app settings.
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

          {/* Policy content */}
          <article className="flex-1 min-w-0">

            {/* Section 1 */}
            <section className="mb-12">
              <h2 id="who-we-are" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                1. Who we are
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                Ferro Maps Ltd ("Ferro Maps", "we", "us", "our") is a private company registered in
                England and Wales. We build a mobile platform that provides real-time demand
                intelligence to private hire and gig economy drivers.
              </p>
              <Table
                headers={[]}
                rows={[
                  ['Data controller', 'Ferro Maps Ltd'],
                  ['Company number', '17197682'],
                  ['Registered office', 'Icon Tower, North Acton, London W3 6FD'],
                  ['ICO registration number', 'ZC147391'],
                  ['Data protection queries', 'privacy@ferromaps.co.uk'],
                ]}
              />
              <p className="text-text-secondary leading-relaxed">
                We are the data controller for the personal data described in this policy. This means
                we decide how and why your data is processed, and we are accountable for doing so
                lawfully. We do not currently have a statutory obligation to appoint a Data Protection
                Officer (DPO). The Lead Developer acts as our designated contact for data protection
                queries.
              </p>
            </section>

            {/* Section 2 */}
            <section className="mb-12">
              <h2 id="what-this-policy-covers" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                2. What this policy covers
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                This policy explains how we collect, use, store, share, and protect your personal data
                when you:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Use the Ferro Maps iOS or Android mobile application</li>
                <li>Visit the Ferro Maps marketing website (ferromaps.co.uk)</li>
                <li>Sign up to our waitlist</li>
                <li>Interact with the Ferro Maps admin dashboard (Faber Motors operators only)</li>
                <li>Contact us by email, social media, or any other channel</li>
              </ul>
              <p className="text-text-secondary leading-relaxed">
                In this policy, "you" and "your" refer to anyone who uses any Ferro Maps product or
                service. Where we say "driver", we mean a gig economy or private hire driver who uses
                the Ferro Maps app.
              </p>
            </section>

            {/* Section 3 */}
            <section className="mb-12">
              <h2 id="data-we-collect" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                3. Data we collect
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                The data we collect depends on how you interact with Ferro Maps.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.1 Data you provide directly
              </h3>
              <Table
                headers={['Category', 'Examples', 'When collected']}
                rows={[
                  [
                    'Phone number',
                    'Your mobile number in E.164 format (e.g. +447123456789)',
                    'Registration (OTP authentication)',
                  ],
                  [
                    'Display name',
                    'The name you enter after verifying your phone number',
                    'Onboarding (profile capture)',
                  ],
                  [
                    'Email address',
                    'Optional email for passwordless sign-in backup',
                    'Onboarding (if you choose to add one)',
                  ],
                  [
                    'Avatar preferences',
                    'Selected avatar preset, skin tone, hair style, accessories',
                    'Profile customisation',
                  ],
                  [
                    'Waitlist sign-up',
                    'Email address and country',
                    'Marketing website waitlist form',
                  ],
                  [
                    'Support messages',
                    'Any information you share when contacting us for help',
                    'When you contact us',
                  ],
                ]}
              />

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.2 Data we collect automatically
              </h3>
              <Table
                headers={['Category', 'Examples', 'Purpose']}
                rows={[
                  [
                    'Location data (GPS)',
                    "Your device's geographic coordinates (latitude and longitude), collected as a GeoPoint while the app is in use",
                    'Matching you to nearby hotspots and enabling proximity-based Ferro earning',
                  ],
                  [
                    'Device information',
                    'Device model, operating system version, unique device hash (activeDeviceId), and FCM push notification token',
                    'Delivering push notifications, enforcing single-device policy, and diagnosing crashes',
                  ],
                  [
                    'App usage data',
                    'Timestamps of sign-in, shift start/end, hotspot interactions, Ferro points earned, and feature usage',
                    'Improving the app, measuring engagement, and debugging',
                  ],
                  [
                    'Crash and performance data',
                    'Crash logs, stack traces, and performance metrics collected via Firebase Crashlytics',
                    'Identifying and fixing bugs',
                  ],
                  [
                    'Analytics data',
                    'Anonymised event data collected via Firebase Analytics (e.g. screen views, feature usage funnels)',
                    'Understanding how drivers use the app to improve the product',
                  ],
                ]}
              />

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.3 Data we generate about you
              </h3>
              <Table
                headers={['Category', 'Examples', 'Purpose']}
                rows={[
                  [
                    'Ferro balance',
                    'Your current accumulated Ferro points',
                    'Gamification and (in Phase 2) subscription redemption',
                  ],
                  [
                    'Earnings history',
                    'Log of each Ferro-earning event: which hotspot, what tier, how many Ferros, when',
                    'Displaying your earnings history and leaderboard ranking',
                  ],
                  [
                    'Subscription status',
                    'Whether you have an active Ferro Maps Premium subscription and when it expires (Phase 2)',
                    'Managing access to premium features',
                  ],
                  [
                    'Country',
                    'ISO country code, defaulting to GB in Phase 1',
                    'Filtering hotspots to your region',
                  ],
                ]}
              />

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                3.4 Data we do not collect
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                We want to be clear about what we do not do:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>
                  We do not access your contacts, camera, microphone, photos, or calendar.
                </li>
                <li>
                  We do not collect financial or payment card information directly. Phase 2
                  subscriptions are processed entirely by Apple (App Store) or Google (Play Store) via
                  RevenueCat; we receive only a subscription status confirmation, never your card
                  details.
                </li>
                <li>
                  We do not collect health data, biometric data, or data about your racial or ethnic
                  origin, religion, sexual orientation, political opinions, or trade union membership.
                </li>
                <li>
                  We do not track you across other apps or websites. We do not use cross-app tracking
                  identifiers.
                </li>
                <li>
                  We do not record your ride history, fare amounts, or passenger information from
                  Uber, Bolt, or any other platform. Ferro Maps is a positioning tool, not a
                  ride-hailing app.
                </li>
              </ul>
            </section>

            {/* Section 4 */}
            <section className="mb-12">
              <h2 id="how-we-use-your-data" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                4. How we use your data and our lawful bases
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                Under UK GDPR, every use of your personal data must have a lawful basis.
              </p>
              <Table
                headers={['What we do with your data', 'Lawful basis']}
                rows={[
                  [
                    'Verify your identity via phone OTP and create your account',
                    'Contract performance — necessary to provide the service you signed up for',
                  ],
                  [
                    'Show you demand hotspots relevant to your location',
                    'Contract performance — this is the core service',
                  ],
                  [
                    'Send you push notifications about nearby Flawless hotspots',
                    'Legitimate interests — timely alerts help you earn more; you can disable notifications in device settings at any time',
                  ],
                  [
                    'Detect proximity to hotspots and award Ferro points',
                    'Contract performance — the gamification system is part of the service',
                  ],
                  [
                    'Display your profile, Ferro balance, and earnings history',
                    'Contract performance',
                  ],
                  [
                    'Show your position on the driver leaderboard',
                    'Legitimate interests — leaderboard participation is part of the product experience',
                  ],
                  [
                    'Send you service emails (e.g. account security, policy updates)',
                    'Legitimate interests — necessary operational communication',
                  ],
                  [
                    'Analyse anonymised usage patterns to improve the app',
                    'Legitimate interests — product improvement benefits all users',
                  ],
                  [
                    'Diagnose and fix crashes and bugs',
                    'Legitimate interests — maintaining a stable, secure app',
                  ],
                  [
                    'Enforce single-device policy',
                    'Legitimate interests — preventing account sharing and subscription abuse',
                  ],
                  [
                    'Process subscription payments (Phase 2)',
                    'Contract performance — fulfilling your subscription purchase',
                  ],
                  [
                    'Respond to support requests and feedback',
                    'Legitimate interests — providing customer support',
                  ],
                  ['Comply with legal obligations', 'Legal obligation'],
                  ['Defend or bring legal claims', 'Legitimate interests'],
                ]}
              />

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                4.1 Legitimate interests balancing
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Where we rely on legitimate interests, we have assessed each purpose and concluded
                that the processing is proportionate, necessary, and does not override your rights
                and freedoms. You can ask us for a summary of any specific assessment by contacting
                us at the address in Section 1.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                4.2 Consent
              </h3>
              <p className="text-text-secondary leading-relaxed">
                We do not currently rely on consent as a lawful basis for any core processing. If we
                introduce optional features in the future that rely on consent (for example, marketing
                emails or optional analytics), we will ask for your explicit, informed consent at that
                point, and you will be able to withdraw it at any time.
              </p>
            </section>

            {/* Section 5 */}
            <section className="mb-12">
              <h2 id="how-we-handle-your-location" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                5. How we handle your location data
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                Location is at the heart of what Ferro Maps does. We take its handling seriously.
              </p>
              <p className="font-medium text-text-primary bg-ferro-tint rounded-lg px-4 py-3 mb-6">
                <strong>Key commitment:</strong> Your GPS data is automatically deleted within 24
                hours. We do not build a long-term location history of where you have been.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.1 When we collect your location
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>
                  We collect your GPS coordinates only while the Ferro Maps app is actively in use
                  and you are signed in.
                </li>
                <li>
                  The app requests "When In Use" location permission on iOS and the equivalent
                  foreground permission on Android. We do not request "Always" (background) location
                  permission.
                </li>
                <li>
                  If you deny location permission, the app will display the map but will not be able
                  to match you to hotspots or award Ferro points based on proximity.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.2 What we do with your location
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-4">
                <li>Match you to nearby demand hotspots and display them on your map.</li>
                <li>
                  Detect when you are within 200 metres of a hotspot to award Ferro points.
                </li>
                <li>
                  Trigger proximity-based push notifications for Flawless-tier hotspots within 3km
                  (if notifications are enabled).
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.3 How long we keep it
              </h3>
              <p className="text-text-secondary leading-relaxed mb-4">
                Your last known GPS position is stored in your user profile in Firestore. A scheduled
                Cloud Function runs nightly and purges all location data older than 24 hours. We do
                not store a trail of locations. We store only a single GeoPoint — your most recent
                position — and delete it within 24 hours of your last update.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                5.4 What we do not do with your location
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>
                  We do not sell your location data to advertisers, data brokers, or any third party.
                </li>
                <li>We do not share your precise location with other drivers.</li>
                <li>We do not use your location to serve targeted advertising.</li>
                <li>
                  We do not track your location in the background when the app is closed.
                </li>
              </ul>
            </section>

            {/* Section 6 */}
            <section className="mb-12">
              <h2 id="who-we-share-with" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                6. Who we share your data with
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                We share personal data only where necessary to provide the service, and only with
                parties who are bound by data protection obligations.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.1 Service providers (data processors)
              </h3>
              <Table
                headers={['Service', 'Provider', 'What it processes', 'Data residency']}
                rows={[
                  [
                    'Authentication',
                    'Firebase Authentication (Google)',
                    'Phone number, email, auth tokens',
                    'europe-west2 (London)',
                  ],
                  [
                    'Database',
                    'Cloud Firestore (Google)',
                    'User profile, location, Ferro balance, earnings',
                    'europe-west2 (London)',
                  ],
                  [
                    'Cloud Functions',
                    'Firebase Cloud Functions (Google)',
                    'Hotspot scoring, location purge, notifications',
                    'europe-west2 (London)',
                  ],
                  [
                    'Push notifications',
                    'Firebase Cloud Messaging (Google)',
                    'FCM token, notification payload',
                    'Google infrastructure (routed via London project)',
                  ],
                  [
                    'Crash reporting',
                    'Firebase Crashlytics (Google)',
                    'Crash logs, device info, stack traces',
                    'Google infrastructure',
                  ],
                  [
                    'Analytics',
                    'Firebase Analytics (Google)',
                    'Anonymised event data, screen views',
                    'Google infrastructure',
                  ],
                  [
                    'Subscriptions (Phase 2)',
                    'RevenueCat',
                    'Subscription status, receipt validation',
                    'US-based; UK IDTA safeguards apply',
                  ],
                  [
                    'Marketing website hosting',
                    'Vercel',
                    'IP address, page views (server logs)',
                    'Edge network; no personal data stored long-term',
                  ],
                  [
                    'Crash reporting (web)',
                    'Sentry',
                    'Error logs from admin dashboard',
                    'EU / US; UK IDTA safeguards apply',
                  ],
                ]}
              />

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.2 Faber Motors Limited
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                Faber Motors Limited is our strategic partner and the operator of the initial driver
                fleet using Ferro Maps. We share the following limited data with Faber Motors through
                the admin dashboard:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2 mb-3">
                <li>
                  Aggregate, anonymised usage statistics (e.g. number of active drivers, hotspot
                  interaction rates).
                </li>
                <li>
                  Driver display names and online/offline status — visible on the admin dashboard
                  for fleet operational purposes.
                </li>
              </ul>
              <p className="text-text-secondary leading-relaxed">
                We do not share your precise location, Ferro balance, earnings history, phone number,
                or email with Faber Motors.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.3 Other disclosures
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                We may disclose your personal data to:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>
                  Law enforcement or regulatory authorities where we are legally required to do so.
                </li>
                <li>
                  Professional advisers (solicitors, accountants) under professional confidentiality
                  obligations.
                </li>
                <li>
                  A successor entity in the event of a merger, acquisition, or asset sale — we would
                  notify you before your data is transferred.
                </li>
              </ul>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                6.4 What we never do
              </h3>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>We never sell your personal data. To anyone. Ever.</li>
                <li>We never share your data with advertisers or ad networks.</li>
                <li>
                  We never share your data with insurance companies, credit agencies, or background
                  check providers.
                </li>
                <li>
                  We never allow third parties to use your data for their own independent purposes.
                </li>
              </ul>
            </section>

            {/* Section 7 */}
            <section className="mb-12">
              <h2 id="where-your-data-is-stored" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                7. Where your data is stored
              </h2>
              <p className="font-medium text-text-primary bg-ferro-tint rounded-lg px-4 py-3 mb-4">
                <strong>Key commitment:</strong> All core data processing takes place in Google
                Cloud's europe-west2 region, which is physically located in London, United Kingdom.
              </p>
              <p className="text-text-secondary leading-relaxed mb-4">
                We have chosen UK-based data residency deliberately. Your user profile, location
                data, Ferro balance, and all Firestore documents are stored and processed in the UK.
              </p>

              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">
                7.1 International transfers
              </h3>
              <p className="text-text-secondary leading-relaxed mb-3">
                Some supporting services (Firebase Crashlytics, Firebase Analytics, RevenueCat,
                Sentry, Vercel) may process limited data outside the UK. Where this happens, we rely
                on one or more of the following safeguards under UK GDPR:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>
                  UK adequacy regulations — for transfers to the EEA and other countries the UK
                  government has deemed adequate.
                </li>
                <li>
                  The UK International Data Transfer Agreement (IDTA) or the UK Addendum to the EU
                  Standard Contractual Clauses — for transfers to the United States and other
                  non-adequate countries.
                </li>
                <li>
                  Supplementary technical measures — including encryption in transit and at rest.
                </li>
              </ul>
            </section>

            {/* Section 8 */}
            <section className="mb-12">
              <h2 id="how-long-we-keep" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                8. How long we keep your data
              </h2>
              <Table
                headers={['Data category', 'Retention period', 'Reason']}
                rows={[
                  [
                    'GPS location (last known position)',
                    '24 hours (automated nightly purge)',
                    'Minimisation — we do not need historical location data',
                  ],
                  [
                    'User profile (name, phone, email, avatar, country)',
                    'Until you delete your account, then deleted within 30 days',
                    'Necessary to provide the service while you use it',
                  ],
                  [
                    'Ferro balance and earnings history',
                    'Until you delete your account, then deleted within 30 days',
                    'Part of the active service',
                  ],
                  [
                    'FCM token and device identifier',
                    'Until you sign out, switch device, or delete your account',
                    'Required for notifications and single-device enforcement',
                  ],
                  [
                    'Firebase Crashlytics logs',
                    "90 days (Google's default retention)",
                    'Bug fixing — older crashes are not actionable',
                  ],
                  [
                    'Firebase Analytics data',
                    "14 months (Google's default, then auto-deleted)",
                    'Product improvement; anonymised and aggregated',
                  ],
                  [
                    'Waitlist sign-up (email, country)',
                    'Until you ask to be removed, or 24 months after sign-up',
                    'Managing the launch waitlist',
                  ],
                  [
                    'Support correspondence',
                    '24 months after the last message in the thread',
                    'Resolving follow-up queries',
                  ],
                  [
                    'Subscription records (Phase 2)',
                    'Duration of subscription + 6 years',
                    'Legal and accounting obligations',
                  ],
                  [
                    'Anonymised, aggregated data',
                    'Indefinitely',
                    'Cannot be linked back to you; used for product analytics',
                  ],
                ]}
              />
              <p className="text-text-secondary leading-relaxed">
                When you delete your account, we initiate deletion of your personal data within 30
                days. Some data may persist in encrypted backups for up to 90 days before being
                overwritten, but it is not accessible or used during that period.
              </p>
            </section>

            {/* Section 9 */}
            <section className="mb-12">
              <h2 id="how-we-protect" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                9. How we protect your data
              </h2>
              <p className="text-text-secondary leading-relaxed mb-3">
                We take the security of your data seriously and apply the following measures:
              </p>
              <ul className="list-disc pl-5 text-text-secondary space-y-2">
                <li>
                  <strong className="text-text-primary font-medium">Encryption in transit</strong> —
                  all communication between your device and our servers uses HTTPS with TLS 1.2 or
                  higher.
                </li>
                <li>
                  <strong className="text-text-primary font-medium">Encryption at rest</strong> —
                  data stored in Firestore and Firebase Authentication is encrypted at rest using
                  Google Cloud's default encryption (AES-256).
                </li>
                <li>
                  <strong className="text-text-primary font-medium">Access controls</strong> —
                  Firestore security rules ensure that you can only read your own profile data.
                </li>
                <li>
                  <strong className="text-text-primary font-medium">App Check</strong> — Firebase
                  App Check verifies that requests come from genuine Ferro Maps app installations.
                </li>
                <li>
                  <strong className="text-text-primary font-medium">Single-device enforcement</strong> —
                  your account can only be active on one device at a time.
                </li>
                <li>
                  <strong className="text-text-primary font-medium">No secrets in code</strong> —
                  API keys and credentials are stored in secure environment variables, never committed
                  to source code.
                </li>
                <li>
                  <strong className="text-text-primary font-medium">Internal access</strong> —
                  access to production Firestore is restricted to authorised Ferro Maps staff with
                  multi-factor authentication required.
                </li>
                <li>
                  <strong className="text-text-primary font-medium">Incident response</strong> — we
                  have procedures to detect, contain, and report data breaches. UK GDPR requires us
                  to notify the ICO within 72 hours of a qualifying breach.
                </li>
              </ul>
            </section>

            {/* Section 10 */}
            <section className="mb-12">
              <h2 id="your-rights" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                10. Your rights
              </h2>
              <p className="text-text-secondary leading-relaxed mb-6">
                UK GDPR gives you rights over your personal data. You can exercise any of these by
                contacting us at the email address in Section 1. We will respond within one calendar
                month.
              </p>

              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.1 Right of access
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You can ask us for a copy of the personal data we hold about you. There is no fee
                    for a reasonable request.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.2 Right to rectification
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You can ask us to correct inaccurate or incomplete data. You can also update your
                    display name, email, and avatar directly in the app.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.3 Right to erasure
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You can ask us to delete your personal data. The simplest way is to delete your
                    account in the app settings — this triggers automatic deletion within 30 days.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.4 Right to restrict processing
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You can ask us to limit our use of your data in certain circumstances.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.5 Right to data portability
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You can request your data in a structured, machine-readable format (JSON). This
                    includes your profile, Ferro balance, and earnings history.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.6 Right to object
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You can object to processing we carry out on the basis of legitimate interests.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.7 Automated decision-making
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    The Ferro Maps app uses rule-based algorithms to score demand hotspots. These are
                    product features, not decisions about you as an individual. We do not make any
                    automated decisions that produce legal or similarly significant effects on you.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.8 Withdrawing consent
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    Where we rely on your consent, you can withdraw it at any time.
                  </p>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">
                    10.9 Right to complain
                  </h3>
                  <p className="text-text-secondary leading-relaxed">
                    You have the right to complain to the ICO at any time. Information
                    Commissioner's Office, Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF.
                    Helpline: 0303 123 1113. Website: ico.org.uk.
                  </p>
                </div>
              </div>
            </section>

            {/* Section 11 */}
            <section className="mb-12">
              <h2 id="childrens-privacy" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                11. Children's privacy
              </h2>
              <p className="text-text-secondary leading-relaxed">
                Ferro Maps is a professional tool for licensed private hire and gig economy drivers.
                It is not intended for use by anyone under the age of 18. We do not knowingly collect
                personal data from children. If we become aware that we have collected data from a
                person under 18, we will delete it promptly.
              </p>
            </section>

            {/* Section 12 */}
            <section className="mb-12">
              <h2 id="cookies-and-tracking" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                12. Cookies and website tracking
              </h2>
              <p className="text-text-secondary leading-relaxed">
                The Ferro Maps mobile app does not use cookies. The marketing website
                (ferromaps.co.uk) uses only essential cookies required for the site to function. We
                do not use advertising cookies, retargeting pixels, or third-party tracking scripts.
                If we introduce non-essential cookies in the future, we will display a cookie consent
                banner and obtain your consent before setting them.
              </p>
            </section>

            {/* Section 13 */}
            <section className="mb-12">
              <h2 id="third-party-links" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                13. Third-party links
              </h2>
              <p className="text-text-secondary leading-relaxed">
                The app or website may contain links to third-party services (for example, Apple App
                Store, Google Play Store, or Tesla Supercharger information). We are not responsible
                for the privacy practices of those services. We encourage you to read their privacy
                policies before providing any personal data.
              </p>
            </section>

            {/* Section 14 */}
            <section className="mb-12">
              <h2 id="changes-to-this-policy" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                14. Changes to this policy
              </h2>
              <p className="text-text-secondary leading-relaxed">
                We may update this policy from time to time. The version number and effective date at
                the top of this document will tell you when it was last updated. For material
                changes, we will notify you via an in-app notification or push notification before
                the changes take effect. Previous versions of this policy are available on request.
              </p>
            </section>

            {/* Section 15 */}
            <section className="mb-12">
              <h2 id="how-to-contact-us" className="text-xl font-bold text-text-primary mb-4 scroll-mt-28">
                15. How to contact us
              </h2>
              <p className="text-text-secondary leading-relaxed mb-4">
                If you have any questions about this policy or would like to exercise any of your
                rights, you can reach us at:
              </p>
              <div className="bg-neutral-50 rounded-xl p-6 text-text-secondary leading-relaxed space-y-1">
                <p className="font-semibold text-text-primary">Ferro Maps Ltd</p>
                <p>Data protection contact: Nafiu Amosa, Lead Developer</p>
                <p>Email: nafiu.a@ferromaps.co.uk</p>
                <p>Post: Icon Tower, North Acton, London W3 6FD</p>
              </div>
              <p className="text-text-secondary leading-relaxed mt-4">
                We aim to respond to all data protection queries within 30 days.
              </p>
            </section>

          </article>
        </div>
      </div>

      {embedded ? null : <Footer />}
    </div>
  )
}
