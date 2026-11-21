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
const BAR_WIDTH = 14
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MODEL_COLORS = [
  ['opus', 'magenta'],
  ['sonnet', 'cyan'],
  ['haiku', 'green'],
] as const

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
const bar = (value: number, max: number) =>
  '█'.repeat(max > 0 && value > 0 ? Math.max(1, Math.round((value / max) * BAR_WIDTH)) : 0).padEnd(BAR_WIDTH)
const dayLabel = (date: string) =>
  `${WEEKDAYS[new Date(`${date}T12:00:00`).getDay()]} ${date.slice(5)}`
const modelColor = (name: string) => MODEL_COLORS.find(([key]) => name.includes(key))?.[1] ?? 'white'
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
    const today = isoDate(new Date(await $.clock.now()))
    const peakDay = report === null ? 0 : Math.max(...report.days.map(d => d.cost), 0)
    const weekCost = report === null ? 0 : report.days.reduce((s, d) => s + d.cost, 0)
    const topModelCost = report === null ? 0 : Math.max(...report.models.map(m => m.cost), 0)
    const modelTotal = report === null ? 0 : report.models.reduce((s, m) => s + m.cost, 0)

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            ◆ ccusage · Claude Code
          </Text>
          <Button
            key="refresh"
            onPress={() => {
              void refresh($)
            }}
          >
            {isLoading ? '⟳ Refreshing…' : '⟳ Refresh'}
          </Button>
        </Box>

        {error !== null && <Text color="red">⚠ {error}</Text>}
        {report === null && error === null && (
          <Text dimColor>Loading usage… the first run can take ~40 s.</Text>
        )}

        {report !== null && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>Updated {clock(report.updatedAt)} · refreshes every 5 min</Text>

            <Box gap={1}>
              <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} flexGrow={1}>
                <Text dimColor>Today</Text>
                <Text bold color="green">{usd(report.todayCost)}</Text>
              </Box>
              <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
                <Text dimColor>This month</Text>
                <Text bold color="cyan">{usd(report.monthCost)}</Text>
              </Box>
              <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} flexGrow={1}>
                <Text dimColor>Last {RANGE_DAYS} days</Text>
                <Text bold color="magenta">{usd(report.rangeCost)}</Text>
              </Box>
            </Box>

            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text bold>Last {SHOWN_DAYS} days</Text>
                <Text dimColor>total {usd(weekCost)}</Text>
              </Box>
              {report.days.map(d => (
                <Box key={d.date} gap={1}>
                  <Text color={d.date === today ? 'green' : undefined} dimColor={d.date !== today}>
                    {dayLabel(d.date)}
                  </Text>
                  <Text color={d.cost === peakDay ? 'yellow' : 'cyan'}>{bar(d.cost, peakDay)}</Text>
                  <Text bold>{usd(d.cost).padStart(8)}</Text>
                  <Text dimColor>out {tokens(d.output)}</Text>
                  {d.cost === peakDay && <Text color="yellow">▲ peak</Text>}
                </Box>
              ))}
            </Box>

            <Box flexDirection="column">
              <Text bold>Models · last {RANGE_DAYS} days</Text>
              {report.models.map(m => (
                <Box key={m.name} gap={1}>
                  <Text color={modelColor(m.name)} bold>
                    {m.name.replace('claude-', '').padEnd(11)}
                  </Text>
                  <Text color={modelColor(m.name)}>{bar(m.cost, topModelCost)}</Text>
                  <Text bold>{usd(m.cost).padStart(9)}</Text>
                  <Text dimColor>
                    {modelTotal > 0 ? `${Math.round((m.cost / modelTotal) * 100)}%`.padStart(4) : '  0%'}
                  </Text>
                  <Text dimColor>out {tokens(m.output)}</Text>
                </Box>
              ))}
            </Box>

            <Text dimColor>
              Estimated API-equivalent cost at list prices, not your subscription charge.
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
