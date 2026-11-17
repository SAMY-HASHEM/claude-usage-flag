import type { On, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// Requirement 2: see the account name.

const NOW = Date.parse('2026-11-17T20:10:00')
const WINDOWS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(Date.parse('2026-11-17T21:30:00')).toISOString() },
]
const PROPS = {
  hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}
const config = (oauthAccount?: object) => JSON.stringify({ numStartups: 3, oauthAccount })

/** The engine beneath the plugin: a subscription session, and a config file per path. */
function engine(on: On, files: Record<string, () => string>) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: WINDOWS } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const read: string[] = []
  on('fs.read', (_, e) => {
    // the engine hands an absolute path of the machine the tests run on: C:\home\... on Windows, /home/... on Linux
    const path = e.path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
    read.push(path)
    const file = files[path]
    if (!file) throw new Error(`ENOENT: ${path}`)
    return { value: file() }
  })
  return read
}

describe('2 · account name', () => {
  test('shows the name and email of the signed-in account, before the usage', async ($, on) => {
    mock.env(on, { HOME: '/home/jovyan' })
    engine(on, {
      '/home/jovyan/.claude.json': () => config({ displayName: 'Samy', emailAddress: 'work@example.com', organizationName: 'x' }),
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect((await ui.find({ type: 'Text', text: /^👤 / }))?.text).toBe('👤 Samy · work@example.com   ')
    // the account comes before the windows, and requirement 1 still shows
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.findIndex(t => t.startsWith('👤 Samy'))).toBeLessThan(texts.indexOf('Session 30 %'))
    await ui.unmount()
  })

  test('reads CLAUDE_CONFIG_DIR first, and shows the email alone when there is no name', async ($, on) => {
    mock.env(on, { HOME: '/home/jovyan', CLAUDE_CONFIG_DIR: '/srv/claude-b/' })
    const read = engine(on, {
      '/home/jovyan/.claude.json': () => config({ emailAddress: 'wrong@example.com' }),
      '/srv/claude-b/.claude.json': () => config({ emailAddress: 'second@example.com' }),
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect((await ui.find({ type: 'Text', text: /^👤 / }))?.text).toBe('👤 second@example.com   ')
    expect(read).not.toContain('/home/jovyan/.claude.json')
    await ui.unmount()
  })

  test('follows a new login when the usage is measured again', async ($, on) => {
    mock.env(on, { HOME: '/home/jovyan' })
    let who = { displayName: 'First', emailAddress: 'first@example.com' }
    engine(on, { '/home/jovyan/.claude.json': () => config(who) })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect((await ui.find({ type: 'Text', text: /^👤 / }))?.text).toBe('👤 First · first@example.com   ')

    who = { displayName: 'Second', emailAddress: 'second@example.com' }
    await $.session.measure({ context: { window: 200_000 }, changed: ['rateLimits'], rateLimits: WINDOWS })
    await ui.redraw()
    expect((await ui.find({ type: 'Text', text: /^👤 / }))?.text).toBe('👤 Second · second@example.com   ')
    await ui.unmount()
  })

  test('with no login record the usage still shows, without an account', async ($, on) => {
    mock.env(on, { HOME: '/home/jovyan' })
    engine(on, { '/home/jovyan/.claude.json': () => config() })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ type: 'Text', text: /^👤 / })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Session 30 %' })).toBeDefined()
    await ui.unmount()
  })
})
