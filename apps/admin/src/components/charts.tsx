/**
 * The chart primitives the admin screens share.
 *
 * Hand-drawn SVG rather than a charting library: these are small, the palette
 * has to come from the Ferro tokens, and a library would be most of the admin
 * bundle. Every chart takes its colours from the same place, so a hotspot
 * category is the same blue on every screen.
 */
const AXIS = '#6B7892'
const GRID = '#EEF2F8'

function niceStep(max: number, divisions: number): number {
  const raw = max / divisions
  const power = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const scaled = raw / power
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return step * power
}

function axisTop(max: number, divisions = 4): { top: number; step: number } {
  if (max <= 0) return { top: divisions, step: 1 }
  const step = niceStep(max * 1.08, divisions)
  return { top: Math.ceil((max * 1.08) / step) * step, step }
}

export type Series = {
  label: string
  values: number[]
  color: string
  /** Drawn as a dashed line with no fill — for a second, smaller measure. */
  dashed?: boolean
}

type LineChartProps = {
  series: Series[]
  labels: string[]
  height?: number
  /** Appended to every value in the tooltip and axis, e.g. '%'. */
  unit?: string
}

/** A trend over days. The last point carries a dot, since it is "now". */
export function LineChart({ series, labels, height = 200, unit = '' }: LineChartProps) {
  const width = 640
  const left = 42
  const right = 14
  const top = 12
  const bottom = 26
  const innerW = width - left - right
  const innerH = height - top - bottom

  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const { top: axisMax, step } = axisTop(max)
  const count = Math.max(labels.length, 1)
  const x = (i: number) => (count === 1 ? left + innerW / 2 : left + (innerW * i) / (count - 1))
  const y = (value: number) => top + innerH - (value / axisMax) * innerH

  const ticks: number[] = []
  for (let value = 0; value <= axisMax + 1e-9; value += step) ticks.push(value)

  const labelEvery = Math.max(1, Math.ceil(count / 6))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img">
      {ticks.map((value) => (
        <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke={GRID} />
          <text x={left - 8} y={y(value) + 4} textAnchor="end" fontSize="11" fill={AXIS}>
            {value}
            {unit}
          </text>
        </g>
      ))}

      {labels.map((label, i) =>
        i % labelEvery === 0 || i === count - 1 ? (
          <text
            key={label}
            x={x(i)}
            y={height - 8}
            textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
            fontSize="11"
            fill={AXIS}
          >
            {label}
          </text>
        ) : null,
      )}

      {series.map((s, index) => {
        const points = s.values.map((value, i) => `${x(i).toFixed(1)},${y(value).toFixed(1)}`)
        const last = s.values.length - 1
        return (
          <g key={s.label}>
            {index === 0 && !s.dashed && s.values.length > 1 && (
              <path
                d={`M${x(0)},${y(0)}L${points.join('L')}L${x(last)},${y(0)}Z`}
                fill={s.color}
                fillOpacity="0.1"
              />
            )}
            <polyline
              points={points.join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeDasharray={s.dashed ? '4 4' : undefined}
            />
            {s.values.length > 0 && (
              <circle cx={x(last)} cy={y(s.values[last])} r="4.5" fill={s.color} stroke="#fff" strokeWidth="2" />
            )}
            {s.values.map((value, i) => (
              <rect
                key={i}
                x={x(i) - innerW / count / 2}
                y={top}
                width={innerW / count}
                height={innerH}
                fill="transparent"
              >
                <title>{`${labels[i]} · ${s.label}: ${value}${unit}`}</title>
              </rect>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

type BarChartProps = {
  /** One entry per bar; each inner array stacks bottom to top. */
  values: number[][]
  labels: string[]
  colors: string[]
  seriesNames: string[]
  height?: number
}

/** Counts per day, stacked when a bar has parts. */
export function BarChart({ values, labels, colors, seriesNames, height = 200 }: BarChartProps) {
  const width = 640
  const left = 42
  const right = 14
  const top = 12
  const bottom = 26
  const innerW = width - left - right
  const innerH = height - top - bottom

  const totals = values.map((parts) => parts.reduce((a, b) => a + b, 0))
  const { top: axisMax, step } = axisTop(Math.max(1, ...totals))
  const slot = innerW / Math.max(values.length, 1)
  const barWidth = Math.max(2, slot - Math.min(12, slot * 0.3))
  const y = (value: number) => top + innerH - (value / axisMax) * innerH

  const ticks: number[] = []
  for (let value = 0; value <= axisMax + 1e-9; value += step) ticks.push(value)
  const labelEvery = Math.max(1, Math.ceil(values.length / 7))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img">
      {ticks.map((value) => (
        <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke={GRID} />
          <text x={left - 8} y={y(value) + 4} textAnchor="end" fontSize="11" fill={AXIS}>
            {value}
          </text>
        </g>
      ))}

      {values.map((parts, i) => {
        const barX = left + i * slot + (slot - barWidth) / 2
        let base = 0
        return (
          <g key={labels[i] ?? i}>
            {parts.map((value, partIndex) => {
              if (value <= 0) return null
              const yTop = y(base + value)
              // A 2px gap keeps stacked segments from reading as one block.
              const segmentHeight = Math.max(1, y(base) - yTop - (base > 0 ? 2 : 0))
              base += value
              return (
                <rect
                  key={partIndex}
                  x={barX}
                  y={yTop}
                  width={barWidth}
                  height={segmentHeight}
                  rx="3"
                  fill={colors[partIndex]}
                >
                  <title>{`${labels[i]} · ${seriesNames[partIndex]}: ${value}`}</title>
                </rect>
              )
            })}
            {i % labelEvery === 0 && (
              <text x={barX + barWidth / 2} y={height - 8} textAnchor="middle" fontSize="11" fill={AXIS}>
                {labels[i]}
              </text>
            )}
          </g>
        )
      })}
      <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="#C2CDDC" />
    </svg>
  )
}

/** The small trend inside a stat tile. No axes: it shows shape, not values. */
export function Sparkline({ values, color = '#0E9BF7' }: { values: number[]; color?: string }) {
  const width = 96
  const height = 30
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />

  const max = Math.max(...values)
  const min = Math.min(...values)
  const x = (i: number) => 2 + ((width - 6) * i) / (values.length - 1)
  const y = (value: number) => height - 3 - ((value - min) / (max - min || 1)) * (height - 8)
  const points = values.map((value, i) => `${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(' ')

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={`M${x(0)},${height}L${points.replace(/ /g, 'L')}L${x(values.length - 1)},${height}Z`} fill={color} fillOpacity="0.12" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.75" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="3" fill={color} stroke="#fff" strokeWidth="1.5" />
    </svg>
  )
}

/** Identity is never colour alone: every chart with parts carries this. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 text-caption text-text-secondary">
          <i className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: item.color }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  )
}
