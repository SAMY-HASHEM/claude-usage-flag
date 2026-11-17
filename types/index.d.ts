/** One usage window as the flag keeps it: `five_hour` (the session) or `seven_day` (the week). */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-flag': {
      /** The windows the last answer reported; empty off a subscription or before the first answer. */
      limits: Limit[]
      /** The clock the countdown is drawn from, moved every 30 s. */
      now: number
      /** The windows already warned about at 90 %, as `kind@resetsAt`. */
      warned: string[]
    }
  }
}
