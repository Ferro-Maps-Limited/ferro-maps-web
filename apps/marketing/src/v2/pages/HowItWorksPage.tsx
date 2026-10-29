import { CheckIcon, LockIcon, PeopleIcon } from '../icons'
import Phone from '../Phone'
import Seo from '../Seo'
import { DownloadButton, DownloadStrip } from '../download'
import { steps } from '../facts'

export default function HowItWorksPage() {
  return (
    <main>
      <Seo
        title="How it works — Ferro Maps"
        description="Download Ferro Maps, see live London demand colour-coded Good, Great and Flawless, and collect Ferro points."
        path="/v2/how-it-works"
      />
      <section className="pg-hero blue">
        <div className="wrap center-t">
          <span className="kicker">How it works</span>
          <h1 className="huge">Open. Go. Earn.</h1>
        </div>
      </section>
      <section className="along">
        <div className="wrap">
          <div className="along-card">
            <h2 className="big">
              Works alongside
              <br />
              your apps.
            </h2>
            <p className="lead">
              Use Ferro next to Uber, Bolt and any ride-hailing app. Ferro never connects to your driver accounts. No
              risk.
            </p>
            <ul className="checks">
              <li>
                <CheckIcon />
                Not connected
              </li>
              <li>
                <CheckIcon />
                No log-ins needed
              </li>
              <li>
                <CheckIcon />
                Your accounts stay safe
              </li>
            </ul>
          </div>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap hsteps">
          <div className="signin-step">
            <span className="num">1</span>
            <div className="lock">
              <LockIcon size={44} color="#0A74BE" />
            </div>
            <h2 className="big">Sign in to Ferro.</h2>
            <p className="lead">{steps[0].body}</p>
            <p className="sub">Ferro only. Never your Uber or Bolt log-in.</p>
          </div>
          <div className="hstep">
            <div className="htext">
              <span className="num">2</span>
              <h2 className="big">See live demand.</h2>
              <p className="lead">{steps[1].body}</p>
            </div>
            <Phone src="/brand/img/surge.webp" width={611} height={1333} alt="Ferro surge screen" />
          </div>
          <div className="hstep alt">
            <div className="htext">
              <span className="num">3</span>
              <h2 className="big">Pick your hotspot.</h2>
              <p className="lead">Stations, venues, airports.</p>
            </div>
            <Phone src="/brand/img/districts.webp" width={540} height={1159} alt="Pick your hotspot." />
          </div>
          <div className="hstep">
            <div className="htext">
              <span className="num">4</span>
              <h2 className="big">Go there first.</h2>
              <p className="lead">Open Ferro. It tells you where to go.</p>
            </div>
            <Phone src="/brand/img/bestmove.webp" width={524} height={1130} alt="Best live opportunity screen" />
          </div>
          <div className="hstep alt">
            <div className="htext">
              <span className="num">5</span>
              <h2 className="big">Plan your day.</h2>
              <p className="lead">See every job in one place. Tap + to add a private job.</p>
              <p className="priv-note">
                <LockIcon />
                Private jobs are only visible to you.
              </p>
              <p className="priv-note ferros-note">
                <PeopleIcon />
                See Ferros around you. No tracking. Go invisible anytime.
              </p>
            </div>
            <Phone src="/brand/img/plan.webp" width={950} height={2068} alt="Plan day view" />
          </div>
          <div className="hstep">
            <div className="htext">
              <span className="num">6</span>
              <h2 className="big">Earn XP.</h2>
              <p className="lead">{steps[2].body}</p>
            </div>
            <Phone
              src="/brand/img/profile.webp"
              width={660}
              height={1354}
              alt="Driver profile. The account name is covered."
            />
          </div>
        </div>
      </section>
      <section className="final">
        <div className="wrap">
          <h2 className="huge">Try it today.</h2>
          <div className="ctas center">
            <DownloadButton className="btn btn-white">Download now</DownloadButton>
          </div>
        </div>
      </section>
      <DownloadStrip />
    </main>
  )
}
