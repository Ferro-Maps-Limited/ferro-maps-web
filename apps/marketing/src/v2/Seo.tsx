import { Helmet } from 'react-helmet-async'
import { OG_IMAGE, SITE } from './links'

type SeoProps = {
  title: string
  description: string
  path: string
  robots?: string
}

export default function Seo({ title, description, path, robots = 'noindex, nofollow' }: SeoProps) {
  const url = `${SITE}${path}`
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={robots} />
      <link rel="canonical" href={url} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Ferro Maps" />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={OG_IMAGE} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="Ferro Maps" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={OG_IMAGE} />
      <meta name="apple-itunes-app" content="app-id=6783352319" />
    </Helmet>
  )
}
