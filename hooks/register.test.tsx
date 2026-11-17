import { expect, test } from 'claude-code/testing'

import { dayKeyOf, formatTokens, mergeDays, parseScan, statsFor } from './heatmap'

const PANE = {
  plugin: 'token-heatmap',
  component: 'Pane',
  requestId: 'token-heatmap',
  props: {
    title: 'Token activity',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const hourAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().slice(0, 13)

// Today: 1,000 in / 500 out / 2,000 cache write / 10,000 cache read over 3 replies.
// 10 days ago: a 1M-token day.
const SCAN = [`${hourAgo(0)} 1000 500 2000 10000 3`, `${hourAgo(240)} 400000 100000 200000 300000 40`].join('\n')

test('scan lines add up into local days, and merging keeps the bigger day', async () => {
  const days = parseScan(SCAN, null)
  const today = dayKeyOf(Date.now(), null)
  expect(days[today]?.output).toBe(500)
  expect(days[today]?.messages).toBe(3)
  const merged = mergeDays({ '2020-01-01': { input: 5, output: 5, cacheWrite: 0, cacheRead: 0, messages: 1 } }, days)
  expect(Object.keys(merged)).toContain('2020-01-01')
  const s = statsFor(merged, '1m', 'all', today)
  expect(s.total).toBe(13_500 + 1_000_000)
  expect(s.activeDays).toBe(2)
  expect(s.earliestData).toBe('2020-01-01')
  expect(statsFor(merged, '1m', 'io', today).total).toBe(1_500 + 500_000)
  expect([500, 10_000, 500_000, 1_000_000, 1_250_000, 2_000_000_000].map(formatTokens)).toEqual(['500', '10K', '500K', '1M', '1.25M', '2B'])
})

test('the pane draws the scanned heatmap and switches range', async ($, on) => {
  on('command.register', () => ({ value: { command: 'token-heatmap' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/test' : undefined }))
  on('process.run', (_, e) => {
    const tool = e.argv[0] ?? ''
    const stdout = tool.endsWith('awk') ? SCAN : tool.endsWith('date') ? '+0000\n' : '/Users/test/.claude/projects/a/b.jsonl\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const svg = await ui.find({ type: 'Svg' })
  expect(String(svg?.props?.source ?? '')).toContain('<rect')
  expect(await ui.find({ type: 'Text', text: /Tokens, past 6 months/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^1\.01M$/ })).toBeTruthy()

  await ui.press({ key: 'range-1m' })
  expect(await ui.find({ type: 'Text', text: /Tokens, past month/ })).toBeTruthy()

  await ui.press({ key: 'metric-io' })
  expect(await ui.find({ type: 'Text', text: /^502K$/ })).toBeTruthy()
  await ui.unmount()

  // Terminal has no Svg: block characters instead.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /■/ })).toBeTruthy()
  await term.unmount()
})
