import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayMap, HeatmapData, HeatmapMetric, HeatmapRange } from '../types'
import {
  SCAN_AWK,
  dayKeyOf,
  formatTokens,
  heatmapSvg,
  heatmapText,
  mergeDays,
  parseOffset,
  parseScan,
  prettyDay,
  statsFor,
} from './heatmap'

const PANE = 'token-heatmap'
const TITLE = 'Token activity'
const STORE_KEY = 'days-v1'
const RESCAN_MS = 10 * 60_000

const initial: HeatmapData = { days: {}, scannedAt: null, isScanning: false, error: null, utcOffset: null }
const data = atom({ plugin: 'token-heatmap', key: 'data' } as const, initial, { shape: 'data-1' })
const range = atom({ plugin: 'token-heatmap', key: 'range' } as const, '6m' as HeatmapRange, { shape: 'range-1' })
const metric = atom({ plugin: 'token-heatmap', key: 'metric' } as const, 'all' as HeatmapMetric, { shape: 'metric-1' })

type Engine = EngineInterface

let isScanRunning = false

async function scan($: Engine): Promise<void> {
  if (isScanRunning) return
  isScanRunning = true
  await update($, data, d => ({ ...d, isScanning: true, error: null }))
  try {
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    const listed = await $.process.run(
      ['/usr/bin/find', `${configDir}/projects`, '-name', '*.jsonl', '-mtime', '-200'],
      { timeoutMs: 60_000 },
    )
    const summed = await $.process.run(['/usr/bin/awk', SCAN_AWK], { stdin: listed.stdout, timeoutMs: 300_000 })
    if (summed.exitCode !== 0) throw new Error(summed.stderr.trim().slice(0, 300) || `awk exited ${summed.exitCode}`)
    const zone = await $.process.run(['/bin/date', '+%z']).catch(() => null)
    const utcOffset = zone ? parseOffset(zone.stdout) : null
    const scanned = parseScan(summed.stdout, utcOffset)
    const stored = ((await $.store.get(STORE_KEY)) ?? {}) as DayMap
    const days = mergeDays(stored, scanned)
    await $.store.set(STORE_KEY, days)
    await update($, data, () => ({ days, scannedAt: Date.now(), isScanning: false, error: null, utcOffset }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, data, d => ({ ...d, isScanning: false, error: message }))
  } finally {
    isScanRunning = false
  }
}

function ago(ms: number | null): string {
  if (ms === null) return 'not yet'
  const min = Math.round((Date.now() - ms) / 60_000)
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'token-heatmap', description: 'Open the token usage heatmap pane' })
    void $.ui.open({ id: PANE, title: TITLE })
    // Show what earlier sessions saved right away, then rescan.
    const stored = ((await $.store.get(STORE_KEY).catch(() => undefined)) ?? {}) as DayMap
    await update($, data, d => ({ ...d, days: mergeDays(stored, d.days) }))
    void scan($)
    $.clock.every(RESCAN_MS, () => void scan($))
    return started
  })

  on('command.run', { command: 'token-heatmap' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void scan($)
    return { text: 'Token activity pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // The terminal has no Svg element: it gets block characters instead.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const d = await read($, data)
    const r = await read($, range)
    const m = await read($, metric)
    const today = dayKeyOf(Date.now(), d.utcOffset)
    const s = statsFor(d.days, r, m, today)
    const label = r === '1m' ? 'past month' : 'past 6 months'
    const metricLabel = m === 'all' ? 'all tokens incl. cache' : 'input + output tokens'
    const alt = `Heatmap of ${metricLabel} per day, ${label}: ${formatTokens(s.total)} total over ${s.activeDays} active days.`

    if (e.props.placement === 'widget') {
      const mini = heatmapSvg(d.days, '1m', m, today, { compact: true })
      return (
        <Box flexDirection="column" gap={1}>
          <Text size="caption" dimColor>Tokens today</Text>
          <Text weight="semibold">{formatTokens(s.today)}</Text>
          {Svg && <Svg source={mini.svg} alt={alt} width={mini.width} height={mini.height} />}
        </Box>
      )
    }

    const stat = (name: string, value: string) => (
      <Box flexDirection="column" minWidth={96}>
        <Text size="caption" dimColor>{name}</Text>
        <Text weight="semibold" tabular>{value}</Text>
      </Box>
    )
    const pickRange = (value: HeatmapRange, text: string) => (
      <Button
        key={`range-${value}`}
        label={text}
        variant={value === r ? 'primary' : 'secondary'}
        onPress={() => void update($, range, () => value)}
      />
    )
    const pickMetric = (value: HeatmapMetric, text: string) => (
      <Button
        key={`metric-${value}`}
        label={text}
        variant={value === m ? 'primary' : 'secondary'}
        onPress={() => void update($, metric, () => value)}
      />
    )
    const gapBeforeData = s.earliestData !== null && s.earliestData > s.first
    const grid = heatmapSvg(d.days, r, m, today)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {pickRange('1m', 'Past month')}
          {pickRange('6m', 'Past 6 months')}
          <Text dimColor>·</Text>
          {pickMetric('all', 'All tokens')}
          {pickMetric('io', 'Input + output')}
          <Button key="refresh" label={d.isScanning ? 'Scanning…' : 'Refresh'} variant="secondary" onPress={() => void scan($)} />
        </Box>

        {Svg ? (
          <Svg source={grid.svg} alt={alt} width={grid.width} height={grid.height} isInteractive />
        ) : (
          <Box flexDirection="column">
            {heatmapText(d.days, r, m, today).map(row => (
              <Text>
                {row.map(level => (level < 0 ? '  ' : ['· ', '▪ ', '▪ ', '■ ', '■ '][level])).join('')}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {stat(`Tokens, ${label}`, formatTokens(s.total))}
          {stat('Output tokens', formatTokens(s.output))}
          {stat('Today', formatTokens(s.today))}
          {stat('Active days', `${s.activeDays} / ${r === '1m' ? 30 : 182}`)}
          {stat('Peak day', s.peak ? `${prettyDay(s.peak.day)} · ${formatTokens(s.peak.total)}` : '—')}
          {stat('Streak', `${s.currentStreak} d (best ${s.longestStreak})`)}
        </Box>

        {d.error && <Text color="error">Scan failed: {d.error}</Text>}
        <Text size="caption" dimColor>
          {`Counting ${metricLabel}. Updated ${d.isScanning && d.scannedAt === null ? '— scanning transcripts…' : ago(d.scannedAt)}.`}
          {gapBeforeData && s.earliestData
            ? ` No local data before ${prettyDay(s.earliestData)}: Claude Code deletes old transcripts (cleanupPeriodDays), so this mod keeps its own daily totals from now on.`
            : ''}
        </Text>
      </Box>
    )
  })
}
