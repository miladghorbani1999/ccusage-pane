import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayRow, ModelRow, Report, UsageView } from '../types'

const PANE = 'ccusage'
// Finds ccusage on the user's own PATH (plus common global-install dirs) and
// falls back to the official package through npx. No user-specific paths.
const LAUNCHER = [
  '/bin/sh',
  '-c',
  'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ' +
    'if command -v ccusage >/dev/null 2>&1; then exec ccusage "$@"; ' +
    'else exec npx -y ccusage@latest "$@"; fi',
  'ccusage',
] as const
const RANGE_DAYS = 35
const REFRESH_MS = 5 * 60 * 1000
const TIMEOUT_MS = 180_000
const SHOWN_DAYS = 7
const DAY_MS = 86_400_000

const view = atom(
  { plugin: 'ccusage-pane', key: 'view' } as const,
  { report: null, error: null, isLoading: false } as UsageView,
  { shape: 'view-1' },
)

type RawModel = { modelName: string; cost: number; outputTokens: number }
type RawDay = {
  date: string
  totalCost: number
  outputTokens: number
  modelBreakdowns?: RawModel[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const compactDate = (d: Date) => isoDate(d).replaceAll('-', '')
const usd = (n: number) => `$${n.toFixed(2)}`
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}K`)

function summarize(daily: readonly RawDay[], now: Date): Report {
  const today = isoDate(now)
  const month = today.slice(0, 7)
  const sum = (rows: readonly RawDay[]) => rows.reduce((total, row) => total + row.totalCost, 0)
  const totals = new Map<string, ModelRow>()
  for (const day of daily) {
    for (const m of day.modelBreakdowns ?? []) {
      const prev = totals.get(m.modelName) ?? { name: m.modelName, cost: 0, output: 0 }
      totals.set(m.modelName, {
        name: m.modelName,
        cost: prev.cost + m.cost,
        output: prev.output + m.outputTokens,
      })
    }
  }
  const days: DayRow[] = daily
    .slice(-SHOWN_DAYS)
    .map(d => ({ date: d.date, cost: d.totalCost, output: d.outputTokens }))
  return {
    updatedAt: now.getTime(),
    todayCost: sum(daily.filter(d => d.date === today)),
    monthCost: sum(daily.filter(d => d.date.startsWith(month))),
    rangeCost: sum(daily),
    days,
    models: [...totals.values()].sort((a, b) => b.cost - a.cost),
  }
}

let isRunning = false

async function refresh($: EngineInterface) {
  if (isRunning) return
  isRunning = true
  await update($, view, v => ({ ...v, isLoading: true }))
  try {
    const now = new Date(await $.clock.now())
    const since = new Date(now.getTime() - RANGE_DAYS * DAY_MS)
    const run = await $.process.run(
      [...LAUNCHER, 'claude', 'daily', '--json', '-b', '--since', compactDate(since)],
      { timeoutMs: TIMEOUT_MS },
    )
    if (run.exitCode !== 0) {
      throw new Error(run.stderr.trim().slice(0, 200) || `ccusage exited ${run.exitCode}`)
    }
    const parsed = JSON.parse(run.stdout) as { daily?: RawDay[] }
    const report = summarize(parsed.daily ?? [], now)
    await update($, view, () => ({ report, error: null, isLoading: false }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, view, v => ({ ...v, error: message, isLoading: false }))
  } finally {
    isRunning = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ccusage',
      description: 'Open the ccusage pane (Claude Code usage and estimated cost)',
    })
    void $.clock.every(REFRESH_MS, () => refresh($))
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'ccusage' }, async $ => {
    await $.ui.open({ id: PANE, title: 'ccusage' })
    void refresh($)

    return { text: 'ccusage pane opened; refreshing.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { report, error, isLoading } = await read($, view)

    return (
      <Box flexDirection="column">
        <Button key="refresh" onPress={() => refresh($)}>
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </Button>
        {error !== null && <Text color="red">Error: {error}</Text>}
        {report === null && error === null && (
          <Text dimColor>Loading usage (first run can take ~40 s)…</Text>
        )}
        {report !== null && (
          <Box flexDirection="column">
            <Text bold>Today: {usd(report.todayCost)}</Text>
            <Text bold>This month: {usd(report.monthCost)}</Text>
            <Text dimColor>
              Last {RANGE_DAYS} days: {usd(report.rangeCost)}
            </Text>
            <Text bold>Last {SHOWN_DAYS} days</Text>
            {report.days.map(d => (
              <Text key={d.date}>
                {d.date} {usd(d.cost).padStart(8)} out {tokens(d.output)}
              </Text>
            ))}
            <Text bold>Models (last {RANGE_DAYS} days)</Text>
            {report.models.map(m => (
              <Text key={m.name}>
                {m.name.replace('claude-', '')} {usd(m.cost)} out {tokens(m.output)}
              </Text>
            ))}
            <Text dimColor>Estimated API-equivalent cost, not a subscription charge.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
