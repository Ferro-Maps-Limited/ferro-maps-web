import { Link } from 'react-router-dom'
import Seo from '../Seo'

export default function NotFoundPage() {
  return (
    <main>
      <Seo
        title="Page not found — Ferro Maps"
        description="That Ferro Maps page is not here."
        path="/v2"
        robots="noindex, nofollow"
      />
      <section className="pg-hero blue">
        <div className="wrap center-t">
          <h1 className="huge">Page not found.</h1>
          <div className="ctas center">
            <Link className="btn btn-white" to="/v2">
              Back home
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}
