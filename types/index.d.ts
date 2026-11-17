/** Token counts for one local calendar day. */
export type DayTotals = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  messages: number
}

/** Days keyed `YYYY-MM-DD` (local time). */
export type DayMap = Record<string, DayTotals>

export type HeatmapData = {
  days: DayMap
  scannedAt: number | null
  isScanning: boolean
  error: string | null
  /** The system's UTC offset in minutes east, from `date +%z`. */
  utcOffset: number | null
}

export type HeatmapRange = '1m' | '6m'
export type HeatmapMetric = 'all' | 'io'

declare module 'claude-code' {
  interface PluginState {
    'token-heatmap': {
      data: Shaped<HeatmapData>
      range: Shaped<HeatmapRange>
      metric: Shaped<HeatmapMetric>
    }
  }
}
