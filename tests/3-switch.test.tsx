import type { CommandInfo, On, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// Requirement 3: switch between the two accounts. The flag remembers both, shows how the other one stands, says when
// the signed-in one runs out and which one has room, and "Switch account" opens /login. The person switches.

const NOW = Date.parse('2026-11-17T20:10:00')
const at = (local: string) => new Date(Date.parse(local)).toISOString()
const PROPS = {
  hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}
const A = { displayName: 'Samy', emailAddress: 'first@example.com' }
const B = { displayName: 'Samy', emailAddress: 'second@example.com' }
const windows = (session: number, week: number, sessionEnds = '2026-11-17T21:30:00'): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: session, resetsAt: at(sessionEnds) },
  { kind: 'seven_day', percentUsed: week, resetsAt: at('2026-11-23T09:00:00') },
]
const LOGIN: CommandInfo = { name: 'login', description: 'Sign in with your Anthropic account', source: 'builtin' }

/** The engine beneath the plugin. `world.login` is who the config file names, `world.usage` what usage() answers. */
function engine(on: On, world: { login: object; usage: SessionRateLimit[] }, options: {
  store?: Record<string, unknown>
  commands?: CommandInfo[]
} = {}) {
  mock.env(on, { HOME: '/home/jovyan' })
  mock.store(on, options.store)
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: world.usage } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
    if (path !== '/home/jovyan/.claude.json') throw new Error(`ENOENT: ${path}`)
    return { value: JSON.stringify({ oauthAccount: world.login }) }
  })
  on('command.list', () => ({ value: options.commands ?? [LOGIN] }))
  const ran: string[] = []
  on('command.run', (_, e) => (ran.push(e.command), { text: '' }))
  return { clock, toasts, ran }
}

const answer = (rateLimits: SessionRateLimit[]) =>
  ({ context: { window: 200_000 }, changed: ['rateLimits' as const], rateLimits })

const other = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Text', text: /^↔ / }))?.text

describe('3 · switch between accounts', () => {
  test('remembers each account it has seen and shows how the other one stands', async ($, on) => {
    const world = { login: A as object, usage: windows(40, 20) }
    engine(on, world)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await other(ui)).toBeUndefined() // one account seen so far

    // the person signed in with the second account, and its first answer was measured
    world.login = B
    world.usage = windows(12, 7, '2026-11-17T23:55:00')
    await $.session.measure(answer(world.usage))
    await ui.redraw()

    expect((await ui.find({ type: 'Text', text: /^👤 / }))?.text).toBe('👤 Samy · second@example.com   ')
    expect(await ui.find({ type: 'Text', text: /^Session 12 %$/ })).toBeDefined()
    expect(await other(ui)).toBe('↔ Samy · first@example.com · Session 40 % · Week 20 % · seen 20:10')
    await ui.unmount()
  })

  test('remembers the other account across sessions', async ($, on) => {
    const seen = { name: 'Samy', email: 'second@example.com', limits: windows(55, 30), seenAt: NOW - 3_600_000 }
    engine(on, { login: A, usage: windows(10, 5) }, { store: { accounts: [seen] } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await other(ui)).toBe('↔ Samy · second@example.com · Session 55 % · Week 30 % · seen 19:10')
    await ui.unmount()
  })

  test('"Switch account" opens /login', async ($, on) => {
    const { ran } = engine(on, { login: A, usage: windows(40, 20) })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ type: 'Button', key: 'switch' })).toBeDefined()
    await ui.press({ key: 'switch' })
    expect(ran).toEqual(['login'])
    await ui.unmount()
  })

  test('where /login is not offered, the button says how to switch', async ($, on) => {
    const { ran, toasts } = engine(on, { login: A, usage: windows(40, 20) }, { commands: [] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    await ui.press({ key: 'switch' })
    expect(ran).toEqual([])
    expect(toasts).toContain('Run /login to sign in with your other account')
    await ui.unmount()
  })

  test('when the account runs out, says so once and names the account with room', async ($, on) => {
    const seen = { name: 'Samy', email: 'second@example.com', limits: windows(30, 10), seenAt: NOW - 600_000 }
    const world = { login: A, usage: windows(100, 64) }
    const { toasts, clock } = engine(on, world, { store: { accounts: [seen] } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.session.measure(answer(world.usage)) // measured again
    await clock.advance(30_000) // and read again by the 30 s refresh

    expect(toasts).toEqual([
      'Samy · first@example.com is out until 21:30 (in 1 h 20 min). ' +
        'Samy · second@example.com has room: press "Switch account" and sign in with it.',
    ])
  })

  test('with no other account known, it asks to sign in with the other one', async ($, on) => {
    const { toasts } = engine(on, { login: A, usage: windows(64, 100) })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect(toasts).toEqual([
      'Samy · first@example.com is out until Mon 09:00 (in 5 d 12 h). ' +
        'Press "Switch account" to sign in with your other account.',
    ])
  })

  test('a remembered window whose end has passed counts as reset', async ($, on) => {
    // the second account ran out earlier, but its session window ended at 19:00
    const seen = {
      name: 'Samy', email: 'second@example.com', limits: windows(100, 40, '2026-11-17T19:00:00'), seenAt: NOW - 7_200_000,
    }
    const { toasts } = engine(on, { login: A, usage: windows(100, 64) }, { store: { accounts: [seen] } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await other(ui)).toBe('↔ Samy · second@example.com · Session 0 % (reset) · Week 40 % · seen 18:10')
    expect(toasts[0]).toContain('Samy · second@example.com has room')
    await ui.unmount()
  })

  test('right after a new login, the old account\'s usage is not shown as the new one\'s', async ($, on) => {
    const world = { login: A as object, usage: windows(97, 50) }
    const { clock } = engine(on, world)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    world.login = B // signed in with the second account; no answer measured yet, usage() still answers the old figures
    await clock.advance(30_000)
    await ui.redraw()
    expect((await ui.find({ type: 'Text', text: /^👤 / }))?.text).toBe('👤 Samy · second@example.com   ')
    expect(await ui.find({ type: 'Text', text: /^usage shows after the next answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Session 97 %$/ })).toBeUndefined()
    expect(await other(ui)).toBe('↔ Samy · first@example.com · Session 97 % · Week 50 % · seen 20:10')

    // the first answer on the new account
    world.usage = windows(3, 1, '2026-11-17T23:55:00')
    await $.session.measure(answer(world.usage))
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /^Session 3 %$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^usage shows after the next answer/ })).toBeUndefined()
    await ui.unmount()
  })
})
