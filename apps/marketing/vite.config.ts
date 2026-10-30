import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

// Mirrors vercel.json for `vite dev` and `vite preview`: Brandon's static
// pages (public/site) at the root routes, /v2/* moved permanently to the
// root, and every other page path answered by the React app (app.html).
const sitePages = ['how-it-works', 'jobs', 'mission', 'socials', 'stories', 'contact']

type SiteResponse = {
  statusCode: number
  setHeader: (name: string, value: string) => void
  end: () => void
}

type SiteRequest = { url?: string; headers: Record<string, string | string[] | undefined> }

function redirect(res: SiteResponse, location: string) {
  res.statusCode = 301
  res.setHeader('Location', location)
  res.end()
}

function attachSiteRoutes(
  middlewares: { use: (fn: (req: SiteRequest, res: SiteResponse, next: () => void) => void) => void },
  staticRoot: string,
) {
  middlewares.use((req, res, next) => {
    const raw = req.url ?? ''
    const pathOnly = raw.split('?')[0]
    const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
    if (pathOnly === '/v2' || pathOnly.startsWith('/v2/')) {
      let rest = pathOnly.slice(3).replace(/^\/index\.html$/, '/').replace(/\.html$/, '')
      if (rest === '') rest = '/'
      redirect(res, rest + query)
      return
    }
    const slashed = pathOnly.match(/^\/([a-z0-9-]+)\/$/)
    if (slashed && sitePages.includes(slashed[1])) {
      redirect(res, `/${slashed[1]}${query}`)
      return
    }
    if (pathOnly === '/') {
      req.url = '/site/index.html' + query
      next()
      return
    }
    const page = pathOnly.match(/^\/([a-z0-9-]+)$/)
    if (page && sitePages.includes(page[1])) {
      req.url = `/site/${page[1]}.html${query}`
      next()
      return
    }
    const accept = String(req.headers.accept ?? '')
    const isFile = path.extname(pathOnly) !== '' || fs.existsSync(path.join(staticRoot, pathOnly))
    const isTooling = /^\/(@|src\/|node_modules\/|site\/)/.test(pathOnly)
    if (accept.includes('text/html') && !isFile && !isTooling) {
      req.url = '/app.html' + query
    }
    next()
  })
}

function siteRoutes(): Plugin {
  return {
    name: 'site-routes',
    configureServer(server) {
      attachSiteRoutes(server.middlewares, path.join(root, 'public'))
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = req.url?.split('?')[0]
        if (pathOnly !== '/site/bridge.js') {
          next()
          return
        }
        const result = await server.transformRequest('/src/site-bridge.ts')
        if (!result) {
          next()
          return
        }
        res.setHeader('Content-Type', 'text/javascript')
        res.end(result.code)
      })
    },
    configurePreviewServer(server) {
      attachSiteRoutes(server.middlewares, path.join(root, 'dist'))
    },
  }
}

export default defineConfig({
  plugins: [react(), siteRoutes()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, 'app.html'),
        bridge: path.resolve(root, 'src/site-bridge.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'bridge' ? 'site/bridge.js' : 'assets/[name]-[hash].js',
      },
    },
  },
})
