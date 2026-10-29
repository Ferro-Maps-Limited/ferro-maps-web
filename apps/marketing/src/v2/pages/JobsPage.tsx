import Seo from '../Seo'
import WaitlistForm from '../WaitlistForm'
import { DownloadStrip } from '../download'
import { jobsLead, stardustJobs } from '../copy'

export default function JobsPage() {
  return (
    <main>
      <Seo
        title="Join the jobs waitlist — Ferro Maps"
        description="Ferro Gold and Stardust will bring private hire pre-booked jobs to drivers."
        path="/v2/jobs"
      />
      <section className="pg-hero gold-hero">
        <div className="wrap center-t">
          <span className="soon">COMING SOON</span>
          <h1 className="huge">
            Jobs sent
            <br />
            to you.
          </h1>
          <p className="lead">Not available yet. A planned list of private-hire pre-booked jobs.</p>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap">
          <div className="pkgs">
            <div className="pkg pkg-gold">
              <img src="/brand/img/bird-gold.webp" width={512} height={512} alt="Ferro Gold" loading="lazy" decoding="async" />
              <h2>
                Ferro <em>Gold</em>
              </h2>
              <p>Pre-booked private hire jobs, straight to your app.</p>
            </div>
            <div className="pkg pkg-star">
              <img src="/brand/img/bird-cosmic.webp" width={512} height={512} alt="Ferro Stardust" loading="lazy" decoding="async" />
              <h2>
                Ferro <em>Stardust</em>
              </h2>
              <p>Planned for Comfort, Luxury and Exec work. Not live.</p>
              <ul className="sd-points">
                <li>For Comfort, Luxury and Exec drivers.</li>
                <li>{stardustJobs}</li>
              </ul>
            </div>
          </div>
          <p className="lead center-t big-lead">{jobsLead}</p>
          <p className="along-line dark center-t">
            Ferro jobs are separate from Uber, Bolt and other platforms. Keep using them as normal.
          </p>
        </div>
      </section>
      <section className="pg-sec tint">
        <div className="wrap narrow">
          <h2 className="big center-t">Join the waitlist.</h2>
          <WaitlistForm variant="card" buttonClassName="btn btn-blue" />
        </div>
      </section>
      <DownloadStrip />
    </main>
  )
}
