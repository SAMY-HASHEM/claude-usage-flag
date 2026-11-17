import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-17T20:10:00')
const WINDOWS = [
  { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(Date.parse('2026-11-23T09:00:00')).toISOString() },
  { kind: 'five_hour', percentUsed: 92, resetsAt: new Date(Date.parse('2026-11-17T21:30:00')).toISOString() },
]

test('the flag shows each window, its end and the time left, on every surface', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {}, rateLimits: WINDOWS } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-flag', surface, component: 'AbovePrompt', props: { hasSurvey: false } })
    expect((await ui.find({ type: 'Text', text: /^Session 92 %$/ }))?.text).toBe('Session 92 %')
    expect((await ui.find({ type: 'Text', text: /ends 21:30 \(in 1 h 20 min\)/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Week 18 %$/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /ends Mon 09:00/ }))).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'switch' })).toBeDefined()
    await ui.unmount()
  }
  // past 90 %: warned once
  expect(toasts.filter(t => t.startsWith('Session: 92 %')).length).toBe(1)
})

test('off a subscription there is no flag', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {}, rateLimits: [] } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-flag', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
