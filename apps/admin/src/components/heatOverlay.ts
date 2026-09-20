import type { HeatPoint } from '../lib/mapData'

/**
 * A heat layer drawn onto the map.
 *
 * Google's own HeatmapLayer was withdrawn in Maps JavaScript 3.65 — the
 * constructor still exists but throws — so this draws the same thing: each
 * driver is a soft blob of intensity, overlapping blobs add up, and the total
 * is coloured through a yellow-orange-red ramp. Adding intensity first and
 * colouring afterwards is what makes neighbouring blobs merge into one
 * organic shape instead of stacking as visibly separate circles.
 */

/** Stops of the ramp: [position 0-1, red, green, blue, alpha]. */
const RAMP: [number, number, number, number, number][] = [
  [0.0, 255, 222, 110, 0],
  [0.18, 255, 214, 92, 170],
  [0.42, 250, 176, 44, 205],
  [0.68, 240, 120, 28, 225],
  [0.86, 220, 64, 32, 238],
  [1.0, 178, 24, 44, 248],
]

/** How wide one driver's blob is on the ground. */
const BLOB_METRES = 1500
const MIN_RADIUS_PX = 24
const MAX_RADIUS_PX = 90

export type HeatOverlay = google.maps.OverlayView & {
  setPoints: (points: HeatPoint[]) => void
}

function rampLookup(): Uint8ClampedArray {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return new Uint8ClampedArray(1024)

  const gradient = ctx.createLinearGradient(0, 0, 256, 0)
  for (const [stop, r, g, b, a] of RAMP) {
    gradient.addColorStop(stop, `rgba(${r},${g},${b},${a / 255})`)
  }
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 256, 1)
  return ctx.getImageData(0, 0, 256, 1).data
}

/** Metres covered by one screen pixel at this latitude and zoom. */
function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
}

export function createHeatOverlay(): HeatOverlay {
  class Overlay extends google.maps.OverlayView {
    private canvas: HTMLCanvasElement | null = null
    private points: HeatPoint[] = []
    private readonly ramp = rampLookup()

    setPoints(points: HeatPoint[]): void {
      this.points = points
      if (this.canvas) this.draw()
    }

    onAdd(): void {
      const canvas = document.createElement('canvas')
      canvas.style.position = 'absolute'
      canvas.style.pointerEvents = 'none'
      this.canvas = canvas
      this.getPanes()?.overlayLayer.appendChild(canvas)
    }

    onRemove(): void {
      this.canvas?.remove()
      this.canvas = null
    }

    draw(): void {
      const canvas = this.canvas
      const projection = this.getProjection()
      const map = this.getMap() as google.maps.Map | undefined
      const bounds = map?.getBounds()
      const zoom = map?.getZoom()
      if (!canvas || !projection || !bounds || zoom === undefined) return

      const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest())
      const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast())
      if (!sw || !ne) return

      const width = Math.max(1, Math.round(ne.x - sw.x))
      const height = Math.max(1, Math.round(sw.y - ne.y))
      canvas.style.left = `${sw.x}px`
      canvas.style.top = `${ne.y}px`
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)
      if (this.points.length === 0) return

      const centreLat = bounds.getCenter().lat()
      const radius = Math.min(
        MAX_RADIUS_PX,
        Math.max(MIN_RADIUS_PX, BLOB_METRES / metresPerPixel(centreLat, zoom)),
      )
      const heaviest = Math.max(...this.points.map((point) => point.weight), 1)

      // Pass one: intensity only, in greyscale. Overlapping blobs add up.
      for (const point of this.points) {
        const pixel = projection.fromLatLngToDivPixel(new google.maps.LatLng(point.lat, point.lng))
        if (!pixel) continue
        const x = pixel.x - sw.x
        const y = pixel.y - ne.y
        if (x < -radius || y < -radius || x > width + radius || y > height + radius) continue

        // A lone driver still has to register, so the floor is well above zero
        // and a crowd is what takes it to the top of the ramp.
        const strength = 0.35 + 0.65 * Math.min(1, point.weight / Math.max(4, heaviest))
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
        gradient.addColorStop(0, `rgba(0,0,0,${strength})`)
        gradient.addColorStop(0.55, `rgba(0,0,0,${strength * 0.45})`)
        gradient.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Pass two: swap each pixel's accumulated alpha for a colour from the ramp.
      const image = ctx.getImageData(0, 0, width, height)
      const pixels = image.data
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3]
        if (alpha === 0) continue
        const offset = alpha * 4
        pixels[i] = this.ramp[offset]
        pixels[i + 1] = this.ramp[offset + 1]
        pixels[i + 2] = this.ramp[offset + 2]
        pixels[i + 3] = this.ramp[offset + 3]
      }
      ctx.putImageData(image, 0, 0)
    }
  }

  return new Overlay()
}
