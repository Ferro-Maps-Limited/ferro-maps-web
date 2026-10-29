import { Link } from 'react-router-dom'
import Phone from '../Phone'
import Seo from '../Seo'
import { DownloadButton, DownloadStrip } from '../download'
import { COMPANY, REGISTERED_OFFICE } from '../facts'

export default function MissionPage() {
  return (
    <main>
      <Seo
        title="Mission — Ferro Maps"
        description="Ferro Maps builds real-time demand intelligence for private hire and gig drivers in London."
        path="/v2/mission"
      />
      <section className="pg-hero blue">
        <div className="wrap center-t">
          <span className="kicker">Our mission</span>
          <h1 className="huge">
            Demand
            <br />
            before you drive.
          </h1>
          <p className="lead">
            {COMPANY} builds a mobile platform that shows private hire and gig drivers where demand is highest.
          </p>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap narrow center-t">
          <div className="mcards">
            <div className="mcard">
              <p className="mh">Live in London.</p>
              <p>The app is live in London. Other cities are on the waitlist.</p>
            </div>
            <div className="mcard">
              <p className="mh">Alongside your apps.</p>
              <p>Keep accepting jobs in Uber, Bolt, or whichever platform you use.</p>
            </div>
            <div className="mcard pinkc">
              <p className="mh">Not a guarantee.</p>
              <p>Ferro shows demand. It is not a ride-hailing app and it does not promise earnings.</p>
            </div>
          </div>
        </div>
      </section>
      <section className="pg-sec tint">
        <div className="wrap center-t">
          <h2 className="big">What the app does today.</h2>
          <div className="mcards m3">
            <div className="mcard">
              <h3>Live hotspots</h3>
              <p>A real-time map of demand zones near you.</p>
            </div>
            <div className="mcard">
              <h3>Good, Great, Flawless</h3>
              <p>Opportunities are colour-coded so you can see the stronger ones first.</p>
            </div>
            <div className="mcard">
              <h3>XP rewards</h3>
              <p>Acting on hotspots earns XP, levels, skins and Ferro bird friends.</p>
            </div>
          </div>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap help-grid">
          <div>
            <h2 className="big">Who we are.</h2>
            <p className="lead">
              {COMPANY} is registered in England and Wales. The registered office is {REGISTERED_OFFICE}. Core driver
              data is stored in London.
            </p>
            <ol className="help">
              <li>
                <span className="num">1</span>
                <div>
                  <h3>Find higher-demand spots</h3>
                  <p>Hotspots on one map, before you set off.</p>
                </div>
              </li>
              <li>
                <span className="num">2</span>
                <div>
                  <h3>See how long they last</h3>
                  <p>Countdown windows, not a promise of a fare.</p>
                </div>
              </li>
              <li>
                <span className="num">3</span>
                <div>
                  <h3>Plan the shift</h3>
                  <p>Opportunities, pre-booked jobs and private jobs in one list.</p>
                </div>
              </li>
              <li>
                <span className="num">4</span>
                <div>
                  <h3>Stay in control</h3>
                  <p>See Ferros nearby. No tracking. Go invisible anytime. Delete your account on the web.</p>
                </div>
              </li>
            </ol>
          </div>
          <Phone
            src="/brand/img/districts.webp"
            width={540}
            height={1159}
            alt="Ferro London district map with hotspot counts"
          />
        </div>
      </section>
      <section className="pg-sec promise">
        <div className="wrap center-t">
          <h2 className="big">
            Built for drivers
            <br />
            in London.
          </h2>
          <div className="ctas center">
            <DownloadButton className="btn btn-white">Download now</DownloadButton>
            <Link className="btn btn-ink" to="/waitlist">
              Join the city waitlist
            </Link>
          </div>
        </div>
      </section>
      <DownloadStrip />
    </main>
  )
}
