import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Account, Known, Limit } from '../types'

// The usage flag, for Claude Code in the terminal: above the prompt, which account is signed in, how much of the
// 5-hour session and of the week it has used, when each window ends and how long until then. The same in short in
// the status line.
//
// Several accounts: each account the session has been signed in with is remembered with the usage it last showed,
// so the flag can say how the other account stands. When the signed-in account runs out, the flag says so and which
// remembered account still has room; the "Switch account" button opens /login to sign in with it. Switching is
// always the person's own: the plugin never changes the account by itself.

const limits = atom({ plugin: 'usage-flag', key: 'limits' } as const, [] as Limit[])
const now = atom({ plugin: 'usage-flag', key: 'now' } as const, 0)
const warned = atom({ plugin: 'usage-flag', key: 'warned' } as const, [] as string[])
const account = atom({ plugin: 'usage-flag', key: 'account' } as const, null as Account | null)
const known = atom({ plugin: 'usage-flag', key: 'known' } as const, [] as Known[])
const awaiting = atom({ plugin: 'usage-flag', key: 'awaiting' } as const, '')

/** Where the remembered accounts persist across sessions, in the plugin's own store. */
const STORE_KEY = 'accounts'
const KEEP_ACCOUNTS = 5

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
/** The windows that stop the account answering when full. */
const BLOCKING = ['five_hour', 'seven_day']

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

/** A remembered window as it stands now: a window whose end has passed has started again at 0 %. */
const asOf = (w: Limit, nowMs: number): Limit =>
  w.resetsAt && Date.parse(w.resetsAt) <= nowMs ? { kind: w.kind, percentUsed: 0 } : w

/** Whether an account with these windows can answer now. */
const hasRoom = (windows: Limit[], nowMs: number) =>
  windows.every(w => !BLOCKING.includes(w.kind) || asOf(w, nowMs).percentUsed < 100)

/** "second@example.com · Session 12 % · Week 7 % · seen 20:40" */
function otherLine(k: Known, nowMs: number): string {
  const windows = k.limits.filter(w => BLOCKING.includes(w.kind))
  return [
    `↔ ${label(k)}`,
    ...windows.map(w => {
      const reset = asOf(w, nowMs) !== w
      return `${NAME[w.kind] ?? w.kind} ${reset ? '0 % (reset)' : `${Math.round(w.percentUsed)} %`}`
    }),
    `seen ${endsAt(new Date(k.seenAt).toISOString(), nowMs)}`,
  ].join(' · ')
}

/** Remembers the account with the windows it shows now, in the store and for drawing. */
async function remember($: EngineInterface, who: Account, windows: Limit[], clock: number): Promise<Known[]> {
  let list: Known[] = []
  try {
    const stored = await $.store.get(STORE_KEY)
    if (Array.isArray(stored)) list = stored as Known[]
  } catch { /* no store: remember for this session only */ }
  list = [{ ...who, limits: windows, seenAt: clock }, ...list.filter(k => k.email !== who.email)].slice(0, KEEP_ACCOUNTS)
  try { await $.store.set(STORE_KEY, list) } catch { /* as above */ }
  await update($, known, () => list)
  return list
}

/**
 * Keeps the windows and the account, writes the status line, warns once per window past 90 %, and once per window
 * that runs out. `measured` is true when the figures come from an answer the engine just measured.
 */
async function keep($: EngineInterface, list: readonly SessionRateLimit[], measured: boolean) {
  let windows = sorted(list)
  const clock = await $.clock.now()
  const who = await signedIn($)
  const before = await read($, account)
  if (who) {
    // a new login: the windows the session holds are still the previous account's until an answer is measured
    if (before && who.email !== before.email && !measured) await update($, awaiting, () => who.email ?? '?')
    if (measured) await update($, awaiting, () => '')
    await update($, account, () => who)
  }
  const waiting = await read($, awaiting)
  if (waiting && waiting === who?.email) windows = []
  await update($, limits, () => windows)
  await update($, now, () => clock)

  const all = who?.email && windows.length ? await remember($, who, windows, clock) : await read($, known)
  const others = all.filter(k => k.email !== who?.email)

  const session = windows.find(w => w.kind === 'five_hour') ?? windows[0]
  $.ui.status(session ? `⚑ ${NAME[session.kind] ?? session.kind} ${Math.round(session.percentUsed)} %` +
    (session.resetsAt ? ` · ends ${endsAt(session.resetsAt, clock)}` : '') : undefined)

  const told = [...(await read($, warned))] // a copy: what state hands back is frozen
  const tell = async (id: string, text: string) => {
    if (told.includes(id)) return
    told.push(id)
    await update($, warned, list => [...list, id].slice(-20))
    $.ui.toast(text)
  }
  for (const w of windows) {
    const id = `${w.kind}@${w.resetsAt ?? ''}`
    const until = w.resetsAt ? ` until ${endsAt(w.resetsAt, clock)} (in ${left(w.resetsAt, clock)})` : ''
    if (w.percentUsed >= 100 && BLOCKING.includes(w.kind)) {
      told.push(id) // out says more than the 90 % warning
      const spare = others.find(k => hasRoom(k.limits, clock))
      const me = who ? label(who) : 'This account'
      await tell(`out:${id}`, spare
        ? `${me} is out${until}. ${label(spare)} has room: press "Switch account" and sign in with it.`
        : `${me} is out${until}. Press "Switch account" to sign in with your other account.`)
    } else if (w.percentUsed >= 90) {
      await tell(id, `${NAME[w.kind] ?? w.kind}: ${Math.round(w.percentUsed)} % used` +
        (w.resetsAt ? `, ends ${endsAt(w.resetsAt, clock)} (in ${left(w.resetsAt, clock)})` : ''))
    }
  }
}

/** Opens /login, where the person signs in with the other account. */
async function switchAccount($: EngineInterface) {
  const names = (await $.command.list()).map(c => c.name)
  if (!names.includes('login')) {
    $.ui.toast('Run /login to sign in with your other account')
    return
  }
  await $.command.run({ command: 'login' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await keep($, (await $.session.usage()).rateLimits, false)
    // the countdown moves every 30 s; a quiet session reads the windows and the login again then too
    $.clock.every(30_000, () => {
      void $.session.usage().then(usage => keep($, usage.rateLimits, false)).catch(() => undefined)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await keep($, e.rateLimits, true)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const windows = await read($, limits)
    const who = await read($, account)
    const waiting = await read($, awaiting)
    const switched = Boolean(waiting && waiting === who?.email)
    // off a subscription, or before the first answer: nothing to show
    if (!windows.length && !switched) return next(e)
    const clock = (await read($, now)) || (await $.clock.now())
    const others = (await read($, known)).filter(k => k.email !== who?.email)
    const { Box, Button, Text } = $.ui.resolve(e)
    const worst = Math.max(0, ...windows.map(w => w.percentUsed))

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={tone(worst)} weight="bold">⚑ </Text>
          {who ? <Text weight="bold">{`👤 ${label(who)}   `}</Text> : null}
          {switched ? <Text dimColor>{'usage shows after the next answer   '}</Text> : null}
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
          <Button key="switch" label="Switch account" onPress={() => switchAccount($)} />
        </Box>
        {others.map(k => (
          <Text key={k.email} dimColor>{otherLine(k, clock)}</Text>
        ))}
      </Box>
    )
  })
}
