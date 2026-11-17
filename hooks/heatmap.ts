import type { DayMap, DayTotals, HeatmapMetric, HeatmapRange } from '../types'

/**
 * Reads transcript paths (one per line) on stdin and prints one line per UTC
 * hour: `YYYY-MM-DDTHH input output cacheWrite cacheRead messages`.
 *
 * Claude Code writes one transcript row per content block, each repeating the
 * request's usage, and resumed sessions copy earlier rows into a new file, so
 * rows are de-duplicated by request id (then message id) and the last row wins.
 */
export const SCAN_AWK = String.raw`
function num(s, key,   p, t) {
  p = index(s, "\"" key "\":")
  if (p == 0) return 0
  t = substr(s, p + length(key) + 3, 24)
  match(t, /^[0-9]+/)
  return RLENGTH > 0 ? substr(t, 1, RLENGTH) + 0 : 0
}
function str(s, key,   p, t) {
  p = index(s, "\"" key "\":\"")
  if (p == 0) return ""
  t = substr(s, p + length(key) + 4, 80)
  return substr(t, 1, index(t, "\"") - 1)
}
BEGIN {
  while ((getline f < "/dev/stdin") > 0) {
    while ((getline line < f) > 0) {
      if (index(line, "\"type\":\"assistant\"") == 0) continue
      u = index(line, "\"usage\":{")
      if (u == 0) continue
      head = substr(line, 1, u)
      body = substr(line, u, 400)
      ts = str(substr(line, u), "timestamp")
      if (ts == "") ts = str(line, "timestamp")
      if (length(ts) < 13) continue
      i = num(body, "input_tokens"); o = num(body, "output_tokens")
      cc = num(body, "cache_creation_input_tokens"); cr = num(body, "cache_read_input_tokens")
      if (i + o + cc + cr == 0) continue
      id = str(line, "requestId")
      if (id == "") id = str(head, "id")
      if (id == "") id = f ":" i ":" cc ":" cr
      hour[id] = substr(ts, 1, 13); I[id] = i; O[id] = o; CC[id] = cc; CR[id] = cr
    }
    close(f)
  }
  for (id in hour) { h = hour[id]; si[h] += I[id]; so[h] += O[id]; sc[h] += CC[id]; sr[h] += CR[id]; n[h]++ }
  for (h in n) printf "%s %d %d %d %d %d\n", h, si[h], so[h], sc[h], sr[h], n[h]
}
`

const DAY_MS = 86_400_000

export const emptyDay = (): DayTotals => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  messages: 0,
})

/** `date +%z` output (`-0800`) as minutes east of UTC; null when unreadable. */
export function parseOffset(text: string): number | null {
  const m = /([+-])(\d\d)(\d\d)/.exec(text.trim())
  if (!m) return null
  const minutes = Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return m[1] === '-' ? -minutes : minutes
}

/**
 * The local-day key of an instant. Uses the runtime's own time zone when it
 * agrees with the system's (so daylight saving is right for past days), else
 * the system's fixed offset.
 */
export function dayKeyOf(ms: number, systemOffset: number | null): string {
  const runtimeOffset = -new Date(Date.now()).getTimezoneOffset()
  if (systemOffset === null || systemOffset === runtimeOffset) {
    const d = new Date(ms)
    return key(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  const d = new Date(ms + systemOffset * 60_000)
  return key(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

const pad = (n: number) => String(n).padStart(2, '0')
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** Turns the awk program's hourly lines into local-day totals. */
export function parseScan(stdout: string, systemOffset: number | null): DayMap {
  const days: DayMap = {}
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const at = Date.parse(`${parts[0] ?? ''}:00:00Z`)
    if (Number.isNaN(at)) continue
    const [input = 0, output = 0, cacheWrite = 0, cacheRead = 0, messages = 0] = parts.slice(1, 6).map(Number)
    const day = (days[dayKeyOf(at, systemOffset)] ??= emptyDay())
    day.input += input || 0
    day.output += output || 0
    day.cacheWrite += cacheWrite || 0
    day.cacheRead += cacheRead || 0
    day.messages += messages || 0
  }
  return days
}

export const totalOf = (d: DayTotals | undefined, metric: HeatmapMetric): number =>
  !d ? 0 : metric === 'io' ? d.input + d.output : d.input + d.output + d.cacheWrite + d.cacheRead

/**
 * Keeps every day ever seen. Transcripts are deleted after a while, so a
 * fresh scan can see less of a day than an earlier one did: keep the larger.
 */
export function mergeDays(stored: DayMap, scanned: DayMap): DayMap {
  const merged: DayMap = { ...stored }
  for (const [day, totals] of Object.entries(scanned)) {
    const old = merged[day]
    if (!old || totalOf(totals, 'all') >= totalOf(old, 'all')) merged[day] = totals
  }
  return merged
}

/** Day keys from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = keyToUtc(from); t <= keyToUtc(to); t += DAY_MS) out.push(utcToKey(t))
  return out
}

export const keyToUtc = (k: string) => {
  const [y = 1970, m = 1, d = 1] = k.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
export const utcToKey = (t: number) => {
  const d = new Date(t)
  return key(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}
export const addDays = (k: string, n: number) => utcToKey(keyToUtc(k) + n * DAY_MS)
const weekday = (k: string) => new Date(keyToUtc(k)).getUTCDay()

export const RANGE_DAYS: Record<HeatmapRange, number> = { '1m': 30, '6m': 182 }

export type Stats = {
  total: number
  output: number
  messages: number
  activeDays: number
  peak: { day: string; total: number } | null
  currentStreak: number
  longestStreak: number
  today: number
  first: string
  last: string
  earliestData: string | null
}

export function statsFor(days: DayMap, range: HeatmapRange, metric: HeatmapMetric, today: string): Stats {
  const first = addDays(today, -(RANGE_DAYS[range] - 1))
  const list = daysBetween(first, today)
  let total = 0
  let output = 0
  let messages = 0
  let activeDays = 0
  let peak: Stats['peak'] = null
  let run = 0
  let longestStreak = 0
  for (const day of list) {
    const value = totalOf(days[day], metric)
    total += value
    output += days[day]?.output ?? 0
    messages += days[day]?.messages ?? 0
    if (value > 0) {
      activeDays++
      run++
      longestStreak = Math.max(longestStreak, run)
      if (!peak || value > peak.total) peak = { day, total: value }
    } else run = 0
  }
  let currentStreak = 0
  // Today not used yet doesn't break the streak.
  for (let i = list.length - 1; i >= 0; i--) {
    if (totalOf(days[list[i] ?? ''], metric) > 0) currentStreak++
    else if (i !== list.length - 1) break
  }
  const keys = Object.keys(days).filter(k => totalOf(days[k], 'all') > 0).sort()
  return {
    total,
    output,
    messages,
    activeDays,
    peak,
    currentStreak,
    longestStreak,
    today: totalOf(days[today], metric),
    first,
    last: today,
    earliestData: keys[0] ?? null,
  }
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${trim(n / 1e9)}B`
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}K`
  return String(Math.round(n))
}
const trim = (x: number) => {
  const fixed = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const prettyDay = (k: string) => {
  const [, m = 1, d = 1] = k.split('-').map(Number)
  return `${MONTHS[m - 1] ?? ''} ${d}`
}

/** Level 0 (none) to 4 (busiest quarter) for each day in view. */
export function levelsFor(values: number[]): (v: number) => number {
  const nonzero = values.filter(v => v > 0).sort((a, b) => a - b)
  if (nonzero.length === 0) return () => 0
  const q = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  const [c1, c2, c3] = cuts as [number, number, number]
  return v => (v <= 0 ? 0 : v < c1 ? 1 : v < c2 ? 2 : v < c3 ? 3 : 4)
}

// One hue at four strengths reads on both light and dark backgrounds.
const FILL = ['rgba(127,127,127,0.16)', 'rgba(46,160,67,0.35)', 'rgba(46,160,67,0.55)', 'rgba(46,160,67,0.78)', 'rgba(46,160,67,1)']
const LABEL = '#8b8b8b'

export type GridOptions = { compact?: boolean }

/** A GitHub-style week-column heatmap as an SVG document. */
export function heatmapSvg(
  days: DayMap,
  range: HeatmapRange,
  metric: HeatmapMetric,
  today: string,
  options: GridOptions = {},
): { svg: string; width: number; height: number } {
  const first = addDays(today, -(RANGE_DAYS[range] - 1))
  const start = addDays(first, -weekday(first)) // back to Sunday
  const list = daysBetween(start, today)
  const values = list.map(d => (d < first ? 0 : totalOf(days[d], metric)))
  const level = levelsFor(values)
  const compact = options.compact ?? false
  const cell = compact ? 9 : range === '1m' ? 22 : 12
  const gap = compact ? 2 : range === '1m' ? 4 : 3
  const left = compact ? 0 : 30
  const top = compact ? 0 : 18
  const weeks = Math.ceil(list.length / 7)
  const gridW = weeks * (cell + gap) - gap
  const gridH = 7 * (cell + gap) - gap
  const legendH = compact ? 0 : 26
  // 1px spare on each edge so today's outline isn't clipped.
  const width = left + gridW + 1
  const height = top + gridH + legendH + 1
  const font = `font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="10" fill="${LABEL}"`
  const parts: string[] = []
  if (!compact) {
    for (const [row, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const) {
      parts.push(`<text x="0" y="${top + row * (cell + gap) + cell * 0.75}" ${font}>${name}</text>`)
    }
    let lastMonth = ''
    for (let w = 0; w < weeks; w++) {
      const sunday = list[w * 7] ?? first
      const month = sunday.slice(0, 7)
      const shown = list.slice(w * 7, w * 7 + 7).find(d => d >= first) ?? sunday
      if (month !== lastMonth && shown.slice(0, 7) === month) {
        lastMonth = month
        // Skip a label that would crowd the next one.
        if (w < weeks - 1 || range === '1m') {
          parts.push(`<text x="${left + w * (cell + gap)}" y="11" ${font}>${prettyDay(sunday).split(' ')[0]}</text>`)
        }
      }
    }
  }
  list.forEach((day, i) => {
    if (day < first) return
    const x = left + Math.floor(i / 7) * (cell + gap)
    const y = top + (i % 7) * (cell + gap)
    const v = values[i] ?? 0
    const d = days[day]
    const tip =
      v > 0 && d
        ? `${prettyDay(day)}: ${formatTokens(v)} tokens (in ${formatTokens(d.input)}, out ${formatTokens(d.output)}, cache write ${formatTokens(d.cacheWrite)}, cache read ${formatTokens(d.cacheRead)}; ${d.messages} replies)`
        : `${prettyDay(day)}: no usage`
    const ring = day === today ? ` stroke="${LABEL}" stroke-width="1"` : ''
    parts.push(
      `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${FILL[level(v)] ?? FILL[0]}"${ring}><title>${tip}</title></rect>`,
    )
  })
  if (!compact) {
    const ly = top + gridH + 10
    const lx = width - (5 * 14 + 62)
    parts.push(`<text x="${lx}" y="${ly + 9}" ${font}>Less</text>`)
    FILL.forEach((f, i) => parts.push(`<rect x="${lx + 28 + i * 14}" y="${ly}" width="10" height="10" rx="2" fill="${f}"/>`))
    parts.push(`<text x="${lx + 28 + 5 * 14 + 2}" y="${ly + 9}" ${font}>More</text>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  return { svg, width, height }
}

/** Rows of block characters for surfaces without SVG (the terminal). */
export function heatmapText(days: DayMap, range: HeatmapRange, metric: HeatmapMetric, today: string): number[][] {
  const first = addDays(today, -(RANGE_DAYS[range] - 1))
  const start = addDays(first, -weekday(first))
  const list = daysBetween(start, today)
  const values = list.map(d => (d < first ? -1 : totalOf(days[d], metric)))
  const level = levelsFor(values)
  const rows: number[][] = Array.from({ length: 7 }, () => [])
  list.forEach((_, i) => {
    const v = values[i] ?? -1
    rows[i % 7]?.push(v < 0 ? -1 : level(v))
  })
  return rows
}
