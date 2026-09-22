// Chart colours live apart from the chart components so both can be imported
// without tripping Fast Refresh, and so every screen splits by hotspot type in
// the same order and the same hues.

/** One fixed order for hotspot types, used by every chart that splits by type. */
export const CATEGORY_COLOR: Record<string, string> = {
  events: '#0B86DA',
  venues: '#E07B14',
  flights: '#12998F',
  'flight disruptions': '#7457D6',
  'travel disruptions': '#7457D6',
  parking: '#D64F8A',
  egg: '#D64F8A',
  unknown: '#94A3B8',
}

export function categoryColor(name: string): string {
  return CATEGORY_COLOR[name.toLowerCase()] ?? CATEGORY_COLOR.unknown
}

/** Outcomes are a state, not a series: good, slow, none. */
export const OUTCOME_COLOR = {
  jobQuick: '#1FA971',
  jobSlow: '#FFB72E',
  noJob: '#E5364A',
} as const
