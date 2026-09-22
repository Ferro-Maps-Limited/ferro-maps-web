import { useEffect, useMemo, useRef, useState } from 'react'
import { GoogleMap, useJsApiLoader, Marker } from '@react-google-maps/api'
import * as ngeohash from 'ngeohash'
import { categoryColor } from '../lib/chartColors'
import { heatPoints, type Cell, type Layers, type Pin } from '../lib/mapData'
import { createHeatOverlay, type HeatOverlay } from './heatOverlay'

const LONDON = { lat: 51.5074, lng: -0.1278 }

/** Google's heatmap needs the visualization library, and a stable array. */
const MAP_LIBRARIES: 'visualization'[] = ['visualization']



const MAP_OPTIONS: google.maps.MapOptions = {
  disableDefaultUI: false,
  zoomControl: true,
  fullscreenControl: false,
  streetViewControl: false,
  mapTypeControl: false,
  styles: [
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ],
}

function pinIcon(color: string): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 32 40"><path d="M16 0C7.163 0 0 7.163 0 16c0 11 16 24 16 24s16-13 16-24C32 7.163 24.837 0 16 0z" fill="${color}"/><circle cx="16" cy="16" r="6" fill="white"/></svg>`,
  )}`
}

type Props = {
  layers: Layers
  cells: Cell[]
  pins: Pin[]
  driverPins: Pin[]
  onSelect?: (pin: Pin) => void
  selectedId?: string | null
  /** Tailwind height class for the map frame. */
  className?: string
}

export default function DensityMap({ layers, cells, pins, driverPins, onSelect, selectedId, className = 'h-full' }: Props) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'ferro-maps-admin-script',
    googleMapsApiKey: apiKey ?? '',
    libraries: MAP_LIBRARIES,
  })
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const heatRef = useRef<HeatOverlay | null>(null)

  const points = useMemo(
    () => (isLoaded ? heatPoints(cells, (hash) => ngeohash.decode(hash)) : []),
    [cells, isLoaded],
  )
  // The heat layer is drawn rather than configured: Google withdrew its own
  // HeatmapLayer in Maps 3.65, and the replacement has to live on a canvas.
  useEffect(() => {
    if (!map || !isLoaded) return

    if (!heatRef.current) heatRef.current = createHeatOverlay()
    const heat = heatRef.current
    heat.setPoints(points)
    heat.setMap(layers.density && points.length > 0 ? map : null)
  }, [map, isLoaded, points, layers.density])

  useEffect(() => () => heatRef.current?.setMap(null), [])

  if (!apiKey) {
    return (
      <div className={`${className} flex items-center justify-center bg-surface-sunken rounded-md p-6 text-center`}>
        <p className="text-body-sm text-text-tertiary">
          No Google Maps key is set for this build, so the map cannot be drawn.
        </p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className={`${className} flex items-center justify-center bg-surface-sunken rounded-md p-6 text-center`}>
        <p className="text-body-sm text-status-danger">Google Maps failed to load.</p>
      </div>
    )
  }

  if (!isLoaded) {
    return <div className={`${className} bg-surface-raised animate-pulse rounded-md`} />
  }

  return (
    <div className={className}>
      <GoogleMap
        mapContainerStyle={{ width: '100%', height: '100%' }}
        center={LONDON}
        zoom={11}
        options={MAP_OPTIONS}
        onLoad={setMap}
      >
        {layers.hotspots &&
          pins.map((pin) => (
            <Marker
              key={pin.id}
              position={{ lat: pin.lat, lng: pin.lng }}
              icon={{
                url: pinIcon(categoryColor(pin.category)),
                scaledSize: new google.maps.Size(selectedId === pin.id ? 34 : 24, selectedId === pin.id ? 44 : 31),
              }}
              title={pin.name}
              onClick={() => onSelect?.(pin)}
            />
          ))}

        {layers.driverPins &&
          driverPins.map((pin) => (
            <Marker
              key={pin.id}
              position={{ lat: pin.lat, lng: pin.lng }}
              icon={{
                url: pinIcon('#D64F8A'),
                scaledSize: new google.maps.Size(22, 28),
              }}
              title={pin.name}
              onClick={() => onSelect?.(pin)}
            />
          ))}
      </GoogleMap>
    </div>
  )
}
