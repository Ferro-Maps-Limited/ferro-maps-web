import { CheckIcon } from '../icons'
import Phone from '../Phone'
import Seo from '../Seo'
import WaitlistForm from '../WaitlistForm'
import { DownloadButton, StoreButtons } from '../download'
import { demandLead, goldTeaser } from '../copy'
import { earnRewards, homeDescription, homeTitle, steps, whenToEarn, whereToEarn } from '../facts'

const PICKS = [
  { src: '/brand/img/filters2.webp', width: 524, height: 1136, alt: 'Ferro filters sheet with hotspot categories', caption: 'Filter' },
  { src: '/brand/img/explore2.webp', width: 513, height: 1108, alt: 'Explore list of opportunities near you', caption: 'Explore' },
  { src: '/brand/img/oxford.webp', width: 546, height: 1183, alt: 'London street map with demand pins', caption: 'Map' },
  {
    src: '/brand/img/profile.webp',
    width: 660,
    height: 1354,
    alt: 'Driver profile. The account name is covered.',
    caption: 'Profile',
  },
  { src: '/brand/img/districts.webp', width: 540, height: 1159, alt: 'London district map with hotspot counts', caption: 'City view' },
]

export default function HomePage() {
  return (
    <main>
      <Seo title={homeTitle} description={homeDescription} path="/v2" />
      <section className="hero" id="top">
        <div className="wrap hero-grid">
          <div>
            <h1>
              Navigation for <span className="surge-word">income.</span>
            </h1>
            <p className="lead">Know where demand is highest before you drive there. Position smarter. Earn more.</p>
            <div className="ctas">
              <DownloadButton className="btn btn-blue">Download now</DownloadButton>
            </div>
            <p className="along-chip">
              <CheckIcon />
              Live in London · Works alongside Uber, Bolt and more · Not connected to your accounts
            </p>
          </div>
          <div className="stage">
            <Phone
              className="hero-ph"
              src="/brand/img/oxford.webp"
              width={546}
              height={1183}
              alt="Ferro map in London"
              priority
            />
          </div>
        </div>
      </section>

      <section className="next" id="why-ferro-maps">
        <div className="wrap split">
          <div>
            <span className="kicker">Why Ferro Maps</span>
            <h2 className="big">
              Where to go.
              <br />
              When to go.
            </h2>
            <p className="lead">{demandLead}</p>
            <p className="next-sub">Three things every London driver needs. All in one place.</p>
          </div>
          <Phone
            src="/brand/img/bestmove.webp"
            width={524}
            height={1130}
            alt="Ferro showing the best live opportunity, with a Go button"
          />
        </div>
      </section>

      <section className="pg-sec">
        <div className="wrap">
          <div className="mcards">
            <div className="mcard">
              <h3>Where to earn</h3>
              <p>{whereToEarn}</p>
            </div>
            <div className="mcard">
              <h3>When to earn</h3>
              <p>{whenToEarn}</p>
            </div>
            <div className="mcard">
              <h3>Earn rewards</h3>
              <p>{earnRewards}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="blue picks">
        <div className="wrap center-t">
          <h2 className="big">See it in action.</h2>
          <p className="lead">Filter demand, explore what is near you, and open your profile.</p>
        </div>
        <div className="carousel" tabIndex={0} aria-label="App screens, swipe to see more">
          <div className="track">
            {PICKS.map((pick) => (
              <figure className="pick" key={pick.caption}>
                <Phone src={pick.src} width={pick.width} height={pick.height} alt={pick.alt} />
                <figcaption>{pick.caption}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="ferros" id="ferros">
        <div className="wrap split">
          <div>
            <h2 className="big">
              See Ferros
              <br />
              around you.
            </h2>
            <p className="lead">Other drivers nearby show as a footprint, not a trail.</p>
            <ul className="checks left">
              <li>
                <CheckIcon />
                No one is tracked
              </li>
              <li>
                <CheckIcon />
                Just a footprint on the map
              </li>
              <li>
                <CheckIcon />
                Go invisible anytime
              </li>
            </ul>
          </div>
          <Phone src="/brand/img/ferros.webp" width={519} height={1124} alt="Map showing other Ferros nearby" />
        </div>
      </section>

      <section className="plan-sec" id="plan">
        <div className="wrap center-t">
          <h2 className="big">Plan your day.</h2>
          <p className="lead">Ferro opportunities, pre-booked jobs and private jobs in one list.</p>
          <div className="plan-pair">
            <figure className="plan-fig">
              <Phone
                src="/brand/img/plan.webp"
                width={950}
                height={2068}
                alt="Plan day view with Ferro opportunities, pre-booked and private jobs"
              />
              <figcaption>
                <b>Your day at a glance</b>
                <ul className="keys">
                  <li>
                    <i className="k-blue" />
                    Ferro opportunity
                  </li>
                  <li>
                    <i className="k-green" />
                    Pre-booked job
                  </li>
                  <li>
                    <i className="k-black" />
                    Private job
                  </li>
                </ul>
              </figcaption>
            </figure>
            <figure className="plan-fig">
              <Phone src="/brand/img/private-job.webp" width={950} height={2068} alt="Add a private job sheet" />
              <figcaption>
                <b>Add a private job</b>
                <span>Tap +. It shows in Plan and on your map.</span>
                <span className="priv-note">Only you can see your private jobs.</span>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="steps-sec" id="how-it-works">
        <div className="wrap center-t">
          <h2 className="big">Get started in 3 steps.</h2>
          <p className="lead">From download to your first opportunity.</p>
          <div className="steps">
            {steps.map((step, index) => (
              <div className={index === 2 ? 'step pinkstep' : 'step'} key={step.title}>
                <span className="num">{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="gold" id="gold">
        <div className="wrap split">
          <div className="gold-bird">
            <div className="shine-wrap">
              <img src="/brand/img/bird-gold.webp" width={512} height={512} alt="Golden Ferro" loading="lazy" decoding="async" />
            </div>
          </div>
          <div>
            <span className="soon">COMING SOON</span>
            <h2 className="big">
              Ferro <em>Gold</em>
            </h2>
            <p className="lead">{goldTeaser}</p>
            <WaitlistForm variant="inline" buttonClassName="btn btn-ink" />
          </div>
        </div>
      </section>

      <section className="final" id="download">
        <div className="wrap">
          <img className="final-bird" src="/brand/img/bird-blue.webp" width={300} height={300} alt="" loading="lazy" decoding="async" />
          <h2 className="huge">
            Start earning
            <br />
            smarter today.
          </h2>
          <p className="along-line">
            Join Ferro Maps and know where demand is highest before you drive there. Live in London.
          </p>
          <StoreButtons />
        </div>
      </section>
    </main>
  )
}
