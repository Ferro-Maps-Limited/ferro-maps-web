import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

const v2CleanPages = ['how-it-works', 'jobs', 'mission', 'socials', 'stories', 'contact']

function mapV2Path(url: string): string | null {
  const pathOnly = url.split('?')[0]
  if (pathOnly === '/v2' || pathOnly === '/v2/') return '/v2/index.html'
  const match = pathOnly.match(/^\/v2\/([a-z0-9-]+)\/?$/)
  if (!match) return null
  if (!v2CleanPages.includes(match[1])) return null
  return `/v2/${match[1]}.html`
}

function attachV2Rewrites(middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void }) {
  middlewares.use((req, _res, next) => {
    const mapped = mapV2Path(req.url ?? '')
    if (!mapped) {
      next()
      return
    }
    const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    req.url = mapped + query
    next()
  })
}

function v2Routes(): Plugin {
  return {
    name: 'v2-routes',
    configureServer(server) {
      attachV2Rewrites(server.middlewares)
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = req.url?.split('?')[0]
        if (pathOnly !== '/v2/bridge.js') {
          next()
          return
        }
        const result = await server.transformRequest('/src/v2-bridge.ts')
        if (!result) {
          next()
          return
        }
        res.setHeader('Content-Type', 'text/javascript')
        res.end(result.code)
      })
    },
    configurePreviewServer(server) {
      attachV2Rewrites(server.middlewares)
    },
  }
}

export default defineConfig({
  plugins: [react(), v2Routes()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, 'index.html'),
        bridge: path.resolve(root, 'src/v2-bridge.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'bridge' ? 'v2/bridge.js' : 'assets/[name]-[hash].js',
      },
    },
  },
})
