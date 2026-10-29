import { Link } from 'react-router-dom'
import Seo from '../Seo'
import { DownloadStrip } from '../download'

export default function StoriesPage() {
  return (
    <main>
      <Seo
        title="Driver stories — Ferro Maps"
        description="Driver stories from people using Ferro Maps in London. None are published yet."
        path="/v2/stories"
      />
      <section className="pg-hero pink">
        <div className="wrap center-t">
          <span className="kicker">Driver stories</span>
          <h1 className="huge">
            Real drivers.
            <br />
            Real shifts.
          </h1>
        </div>
      </section>
      <section className="pg-sec">
        <div className="wrap">
          <div className="empty">
            <h2>Stories coming soon.</h2>
            <p className="lead">
              The previous site used placeholder quotes. We are not publishing a driver story until we have permission
              and a real account of a shift.
            </p>
            <Link className="btn btn-blue" to="/v2/contact">
              Share your story
            </Link>
          </div>
        </div>
      </section>
      <DownloadStrip />
    </main>
  )
}
