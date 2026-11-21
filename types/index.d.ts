export type DayRow = { date: string; cost: number; output: number }
export type ModelRow = { name: string; cost: number; output: number }
export type Report = {
  updatedAt: number
  todayCost: number
  monthCost: number
  rangeCost: number
  days: DayRow[]
  models: ModelRow[]
}
export type UsageView = { report: Report | null; error: string | null; isLoading: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ccusage-pane': { view: Shaped<UsageView> }
  }
}
