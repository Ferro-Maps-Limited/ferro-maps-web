import { useState } from 'react'
import { Card } from '@ferro-maps/ui'
import { Check, Layers as LayersIcon, X } from 'lucide-react'
import AppShell from '../components/AppShell'
import DensityMap from '../components/DensityMap'
import { useMapData, type Layers, type Pin } from '../lib/mapData'
import { categoryColor } from '../lib/chartColors'
import { useLiveStats } from '../lib/adminStats'
import { formatDateTime } from '../lib/driverProfile'

const CATEGORY_KEYS = ['events', 'venues', 'flights', 'flight disruptions', 'travel disruptions']

function Toggle({ on, label, count, onClick }: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2.5 py-1.5 w-full text-left group">
      <span
        className={`w-4 h-4 rounded flex items-center justify-center border ${
          on ? 'bg-ferro-primary border-ferro-primary text-white' : 'border-border-strong'
        }`}
      >
        {on && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="text-body-sm text-text-primary flex-1 group-hover:text-ferro-primary">{label}</span>
      {count !== undefined && <span className="text-caption text-text-tertiary tabular-nums">{count}</span>}
    </button>
  )
}

/** A field out of the hotspot's own `events` map, which differs per category. */
function detailRow(label: string, value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const text =
    typeof value === 'object' && value !== null && 'toDate' in value
      ? (value as { toDate: () => Date }).toDate().toLocaleString('en-GB', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : String(value)
  return (
    <div key={label} className="flex justify-between gap-3 py-1.5 border-b border-border-subtle last:border-0">
      <span className="text-body-sm text-text-tertiary capitalize">{label.replace(/_/g, ' ')}</span>
      <span className="text-body-sm text-text-primary font-medium text-right">{text}</span>
    </div>
  )
}

export default function LiveMap() {
  const [layers, setLayers] = useState<Layers>({ density: true, hotspots: true, driverPins: true })
  const [selected, setSelected] = useState<Pin | null>(null)
  const { cells, pins, driverPins } = useMapData(layers)
  const { stats: live } = useLiveStats()

  const driversOut = cells.reduce((sum, cell) => sum + cell.total, 0)
  const byCategory = CATEGORY_KEYS.map((key) => ({
    key,
    count: pins.filter((pin) => pin.category === key).length,
  })).filter((entry) => entry.count > 0)

  return (
    <AppShell title="Live map">
      <div className="relative h-[calc(100vh-10rem)] min-h-[520px] rounded-card overflow-hidden border border-border-default">
        <DensityMap
          layers={layers}
          cells={cells}
          pins={pins}
          driverPins={driverPins}
          onSelect={setSelected}
          selectedId={selected?.id}
        />

        <Card className="absolute left-4 top-4 w-60 !p-4 shadow-elevation-3">
          <p className="flex items-center gap-2 text-label font-semibold text-text-primary mb-2">
            <LayersIcon size={15} />
            Layers
          </p>

          <Toggle
            on={layers.density}
            label="Drivers out now"
            count={driversOut}
            onClick={() => setLayers((l) => ({ ...l, density: !l.density }))}
          />
          <Toggle
            on={layers.hotspots}
            label="Hotspots"
            count={pins.length}
            onClick={() => setLayers((l) => ({ ...l, hotspots: !l.hotspots }))}
          />
          {layers.hotspots && (
            <div className="pl-6 pb-1 flex flex-col gap-1">
              {byCategory.map(({ key, count }) => (
                <span key={key} className="flex items-center gap-2 text-caption text-text-secondary capitalize">
                  <i className="w-2 h-2 rounded-full" style={{ backgroundColor: categoryColor(key) }} />
                  {key}
                  <span className="ml-auto tabular-nums text-text-tertiary">{count}</span>
                </span>
              ))}
            </div>
          )}
          <Toggle
            on={layers.driverPins}
            label="Driver pins"
            count={driverPins.length}
            onClick={() => setLayers((l) => ({ ...l, driverPins: !l.driverPins }))}
          />

          <div className="mt-3 pt-3 border-t border-border-subtle">
            <p className="text-caption text-text-tertiary mb-1.5">How many drivers</p>
            <div
              className="h-2 rounded-full"
              style={{
                background:
                  'linear-gradient(90deg, rgba(255,214,92,0.7), rgba(250,176,44,0.85), rgba(240,120,28,0.9), rgba(178,24,44,1))',
              }}
            />
            <div className="flex justify-between text-caption text-text-tertiary mt-1">
              <span>A few</span>
              <span>Packed</span>
            </div>
            <p className="text-caption text-text-tertiary mt-2">
              Counted from live positions, never shown as individual drivers.
            </p>
          </div>
        </Card>

        {selected ? (
          <Card className="absolute right-4 top-4 bottom-4 w-[320px] !p-5 shadow-elevation-3 overflow-y-auto">
            <div className="flex items-start justify-between gap-2 mb-3">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize"
                style={{ backgroundColor: `${categoryColor(selected.category)}1a`, color: categoryColor(selected.category) }}
              >
                <i className="w-2 h-2 rounded-full" style={{ backgroundColor: categoryColor(selected.category) }} />
                {selected.isDriverPin ? 'Driver pin' : selected.category}
              </span>
              <button
                onClick={() => setSelected(null)}
                className="text-text-tertiary hover:text-text-primary"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-subtitle font-bold text-text-primary leading-tight">{selected.name}</p>
            {selected.city && <p className="text-body-sm text-text-tertiary mb-3">{selected.city}</p>}

            <div className="mt-2">
              {detailRow('expires', selected.expiresAt)}
              {detailRow('arrived in the app', selected.fetchedAt)}
              {selected.confirmCount !== undefined && detailRow('confirmed by drivers', selected.confirmCount)}
              {selected.details &&
                Object.entries(selected.details)
                  .filter(([, value]) => typeof value !== 'object' || (value && 'toDate' in (value as object)))
                  .slice(0, 8)
                  .map(([key, value]) => detailRow(key, value))}
            </div>

            {selected.demand && (
              <div className="mt-4 rounded-md bg-amber-50 p-3">
                <p className="text-body-sm font-semibold text-text-primary mb-1">What we think of it</p>
                <div className="flex flex-col">
                  {['band', 'severity', 'expectedRiders', 'replacementTransport', 'reason'].map((key) =>
                    detailRow(key, selected.demand?.[key]),
                  )}
                </div>
              </div>
            )}
          </Card>
        ) : (
          <Card className="absolute right-4 top-4 w-[260px] !p-4 shadow-elevation-3">
            <p className="text-label font-semibold text-text-primary mb-1">
              {driversOut} driver{driversOut === 1 ? '' : 's'} out now
            </p>
            <p className="text-caption text-text-tertiary">
              {live?.builtAt ? `Last counted ${formatDateTime(live.builtAt)}` : 'Waiting for the live count'}
            </p>
            <p className="text-body-sm text-text-secondary mt-3">Click a pin to see what is happening there.</p>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
