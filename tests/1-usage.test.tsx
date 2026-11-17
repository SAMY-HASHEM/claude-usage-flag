import type { SessionRateLimit } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

// Requirement 1: see the usage percentage (5-hour session and week) in the terminal.

const NOW = Date.parse('2026-11-17T20:10:00')
const at = (local: string) => new Date(Date.parse(local)).toISOString()
const WINDOWS: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 18.4, resetsAt: at('2026-11-23T09:00:00') },
  { kind: 'five_hour', percentUsed: 92.2, resetsAt: at('2026-11-17T21:30:00') },
]
const PROPS = {
  hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}
const USAGE = (rateLimits: SessionRateLimit[]) => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits } })

describe('1 · usage percentage', () => {
  test('shows the session and week percentages, when each ends and the time left', async ($, on) => {
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => USAGE(WINDOWS))
    on('clock.now', () => ({ value: NOW }))
    on('clock.every', () => ({ value: undefined }))
    const status: (string | undefined)[] = []
    on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
    on('ui.toast', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    // session first, then week, rounded
    const texts = (await ui.findAll({ type: 'Text', text: /^(Session|Week) \d+ %$/ })).map(t => t.text)
    expect(texts).toEqual(['Session 92 %', 'Week 18 %'])
    expect(await ui.find({ type: 'Text', text: /ends 21:30 \(in 1 h 20 min\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ends Mon 09:00 \(in 5 d 12 h\)/ })).toBeDefined()
    // the status line carries the session in short
    expect(status.at(-1)).toBe('⚑ Session 92 % · ends 21:30')
    await ui.unmount()
  })

  test('warns once when a window passes 90 %', async ($, on) => {
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => USAGE(WINDOWS))
    on('clock.now', () => ({ value: NOW }))
    on('clock.every', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    const toasts: string[] = []
    on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    // the same windows measured again: no second warning
    await $.session.measure({ context: { window: 200_000 }, changed: ['rateLimits'], rateLimits: WINDOWS })

    expect(toasts).toEqual(['Session: 92 % used, ends 21:30 (in 1 h 20 min)'])
  })

  test('follows the percentage as answers move it', async ($, on) => {
    // the engine's figures: what usage() answers is what the last answer measured
    let current: SessionRateLimit[] = [{ kind: 'five_hour', percentUsed: 40, resetsAt: at('2026-11-17T21:30:00') }]
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => USAGE(current))
    on('clock.now', () => ({ value: NOW }))
    on('clock.every', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'Session 40 %' })).toBeDefined()

    current = [{ kind: 'five_hour', percentUsed: 71, resetsAt: at('2026-11-17T21:30:00') }]
    await $.session.measure({ context: { window: 200_000 }, changed: ['rateLimits'], rateLimits: current })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: 'Session 71 %' })).toBeDefined()
    await ui.unmount()
  })

  test('off a subscription there is no flag', async ($, on) => {
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => USAGE([]))
    on('clock.now', () => ({ value: NOW }))
    on('clock.every', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  })
})
