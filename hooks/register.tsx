import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Account, Limit } from '../types'

// The usage flag, for Claude Code in the terminal: above the prompt, which account is signed in, how much of the
// 5-hour session and of the week it has used, when each window ends and how long until then. The same in short in
// the status line.

const limits = atom({ plugin: 'usage-flag', key: 'limits' } as const, [] as Limit[])
const now = atom({ plugin: 'usage-flag', key: 'now' } as const, 0)
const warned = atom({ plugin: 'usage-flag', key: 'warned' } as const, [] as string[])
const account = atom({ plugin: 'usage-flag', key: 'account' } as const, null as Account | null)

/**
 * The signed-in account, from the login record Claude Code keeps in its config file
 * (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). Null with no login there.
 */
async function signedIn($: EngineInterface): Promise<Account | null> {
  try {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!dir) return null
    const config = JSON.parse(await $.fs.read(`${dir.replace(/[\\/]+$/, '')}/.claude.json`)) as {
      oauthAccount?: { displayName?: string; fullName?: string; emailAddress?: string; organizationName?: string }
    }
    const o = config.oauthAccount
    if (!o?.emailAddress && !o?.displayName && !o?.fullName) return null
    return { name: o.displayName || o.fullName || undefined, email: o.emailAddress || undefined }
  } catch {
    return null // no config yet, one being written, or no access: keep what is shown
  }
}

/** "Samy · samy@example.com", or whichever of the two the login recorded. */
const label = (a: Account) => [a.name, a.email].filter(Boolean).join(' · ')

const NAME: Record<string, string> = { five_hour: 'Session', seven_day: 'Week', spend_limit: 'Spend' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']

const tone = (percent: number) => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')
const two = (n: number) => String(n).padStart(2, '0')

/** "21:30", or "Mon 09:00" when the window ends on another day. */
function endsAt(iso: string, nowMs: number): string {
  const end = new Date(iso), today = new Date(nowMs)
  const time = `${two(end.getHours())}:${two(end.getMinutes())}`
  if (end.toDateString() === today.toDateString()) return time
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][end.getDay()]} ${time}`
}

/** "1 h 20 min", "12 min", "2 d 4 h". */
function left(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - nowMs) / 60000))
  if (minutes >= 48 * 60) return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  return `${minutes} min`
}

const rank = (kind: string) => (ORDER.indexOf(kind) + 99) % 99 // unknown kinds last

const sorted = (list: readonly SessionRateLimit[] | Limit[]): Limit[] =>
  [...list]
    .map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    .sort((a, b) => rank(a.kind) - rank(b.kind))

/** Keeps the windows, writes the status line, and warns once per window past 90 %. */
async function keep($: EngineInterface, list: readonly SessionRateLimit[]) {
  const windows = sorted(list), clock = await $.clock.now()
  const who = await signedIn($)
  if (who) await update($, account, () => who)
  await update($, limits, () => windows)
  await update($, now, () => clock)
  const session = windows.find(w => w.kind === 'five_hour') ?? windows[0]
  $.ui.status(session ? `⚑ ${NAME[session.kind] ?? session.kind} ${Math.round(session.percentUsed)} %` +
    (session.resetsAt ? ` · ends ${endsAt(session.resetsAt, clock)}` : '') : undefined)
  const told = await read($, warned)
  for (const w of windows) {
    const id = `${w.kind}@${w.resetsAt ?? ''}`
    if (w.percentUsed >= 90 && !told.includes(id)) {
      await update($, warned, list => [...list.slice(-9), id])
      $.ui.toast(`${NAME[w.kind] ?? w.kind}: ${Math.round(w.percentUsed)} % used` +
        (w.resetsAt ? `, ends ${endsAt(w.resetsAt, clock)} (in ${left(w.resetsAt, clock)})` : ''))
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await keep($, (await $.session.usage()).rateLimits)
    // the countdown moves every 30 s; a quiet session reads the windows again then too
    $.clock.every(30_000, () => {
      void $.session.usage().then(usage => keep($, usage.rateLimits)).catch(() => undefined)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await keep($, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const windows = await read($, limits)
    if (!windows.length) return next(e) // off a subscription, or before the first answer: nothing to show
    const clock = (await read($, now)) || (await $.clock.now())
    const { Box, Text } = $.ui.resolve(e)
    const worst = Math.max(...windows.map(w => w.percentUsed))
    const who = await read($, account)

    return (
      <Box>
        <Text color={tone(worst)} weight="bold">⚑ </Text>
        {who ? <Text weight="bold">{`👤 ${label(who)}   `}</Text> : null}
        {windows.map(w => (
          <Text key={w.kind}>
            <Text color={tone(w.percentUsed)} weight="semibold" tabular>
              {NAME[w.kind] ?? w.kind} {Math.round(w.percentUsed)} %
            </Text>
            <Text dimColor>
              {w.resetsAt ? ` · ends ${endsAt(w.resetsAt, clock)} (in ${left(w.resetsAt, clock)})` : ''}
              {'   '}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
