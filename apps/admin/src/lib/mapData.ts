import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query, where, GeoPoint, Timestamp } from 'firebase/firestore'
import { db } from './firebase'

/**
 * What the map draws, and where it comes from.
 *
 * Drivers are counts per geohash cell, never pins. driverLocations is
 * owner-only — the rules call it the most sensitive data in the product, after
 * a leak that handed out the whole fleet's live positions — and driverDensity
 * exists so a map can say "eleven drivers here" without saying who. It also
 * drops a cell once its positions go stale, so it counts drivers who are
 * actually out rather than accounts that forgot to sign off.
 */

/** Live pins fetched at once. Enough to fill a city; the rest are off-screen. */
const HOTSPOT_LIMIT = 400
const CONTRIBUTION_LIMIT = 200

export type Cell = {
  /** Geohash prefix, 5 characters — about 5 km across. */
  id: string
  total: number
  /**
   * Counts within the cell at 7 characters — about 150 m. The trigger keeps
   * these so a map can show where in a city drivers actually are, rather than
   * lighting up the whole cell.
   */
  buckets: Record<string, number>
}

/** One blob of heat: a place, and how many drivers are sitting on it. */
export type HeatPoint = { lat: number; lng: number; weight: number }

export type Pin = {
  id: string
  name: string
  category: string
  city?: string
  lat: number
  lng: number
  expiresAt?: Timestamp | null
  fetchedAt?: Timestamp | null
  details?: Record<string, unknown>
  demand?: Record<string, unknown>
  confirmCount?: number
  isDriverPin?: boolean
}

export type Layers = { density: boolean; hotspots: boolean; driverPins: boolean }

function toPin(id: string, data: Record<string, unknown>, isDriverPin = false): Pin | null {
  const location = data.location as GeoPoint | undefined
  if (!location || typeof location.latitude !== 'number') return null
  return {
    id,
    name: (data.name as string) ?? (data.description as string) ?? 'Unnamed',
    category: (data.category as string) ?? 'unknown',
    city: data.city as string | undefined,
    lat: location.latitude,
    lng: location.longitude,
    expiresAt: (data.expire_at as Timestamp) ?? (data.expiresAt as Timestamp) ?? null,
    fetchedAt: (data.fetched_at as Timestamp) ?? null,
    details: data.events as Record<string, unknown> | undefined,
    demand: data.demand as Record<string, unknown> | undefined,
    confirmCount: data.confirmCount as number | undefined,
    isDriverPin,
  }
}

export function useMapData(layers: Layers) {
  const [cells, setCells] = useState<Cell[]>([])
  const [pins, setPins] = useState<Pin[]>([])
  const [driverPins, setDriverPins] = useState<Pin[]>([])

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'driverDensity'),
      (snap) =>
        setCells(
          snap.docs.map((d) => ({
            id: d.id,
            total: (d.get('total') as number) ?? 0,
            buckets: (d.get('buckets') as Record<string, number>) ?? {},
          })),
        ),
      (error) => console.error('driverDensity could not be read:', error),
    )
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!layers.hotspots) return
    const q = query(
      collection(db, 'hotspots_test'),
      where('expire_at', '>', Timestamp.now()),
      orderBy('expire_at'),
      limit(HOTSPOT_LIMIT),
    )
    const unsub = onSnapshot(
      q,
      (snap) => setPins(snap.docs.map((d) => toPin(d.id, d.data())).filter((p): p is Pin => p !== null)),
      (error) => console.error('hotspots could not be read:', error),
    )
    return () => unsub()
  }, [layers.hotspots])

  useEffect(() => {
    if (!layers.driverPins) return
    const unsub = onSnapshot(
      query(collection(db, 'contributions'), limit(CONTRIBUTION_LIMIT)),
      (snap) => setDriverPins(snap.docs.map((d) => toPin(d.id, d.data(), true)).filter((p): p is Pin => p !== null)),
      (error) => console.error('contributions could not be read:', error),
    )
    return () => unsub()
  }, [layers.driverPins])

  return { cells, pins, driverPins }
}


/**
 * Cells turned into heat points, at the finest resolution the data holds.
 *
 * A cell's buckets are used when it has them, so the heat sits where drivers
 * are rather than smearing across five kilometres; a cell without buckets
 * falls back to its own centre.
 */
export function heatPoints(cells: Cell[], decode: (hash: string) => { latitude: number; longitude: number }): HeatPoint[] {
  const points: HeatPoint[] = []
  for (const cell of cells) {
    const buckets = Object.entries(cell.buckets ?? {})
    if (buckets.length === 0) {
      const centre = decode(cell.id)
      points.push({ lat: centre.latitude, lng: centre.longitude, weight: cell.total })
      continue
    }
    for (const [hash, count] of buckets) {
      const centre = decode(hash)
      points.push({ lat: centre.latitude, lng: centre.longitude, weight: count })
    }
  }
  return points
}
