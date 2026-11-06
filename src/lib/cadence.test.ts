import { describe, expect, it } from 'vitest'
import {
  cadenceMessage,
  emptyStep,
  emptyTemplateForm,
  localDate,
  prepTimeline,
  skippedSteps,
  stepStart,
  summarisePlan,
  toStepsJson,
  validateTemplate,
  type TemplateForm,
} from './cadence'

// Event: Saturday 2026-12-12 09:00 Phoenix = 16:00Z.
const EVENT = '2026-12-12T16:00:00.000Z'
const PHX = 'America/Phoenix'

describe('stepStart', () => {
  it('counts whole days back from the local date, at the step time', () => {
    expect(stepStart(EVENT, PHX, 7, '19:00')).toBe('2026-12-06T02:00:00.000Z') // Sat 5 Dec 19:00 local
    expect(stepStart(EVENT, PHX, 0, '07:30')).toBe('2026-12-12T14:30:00.000Z')
  })
  it('uses the local date, not the UTC date (an evening event)', () => {
    // 2026-12-13T03:00Z is 20:00 on the 12th in Phoenix.
    expect(localDate('2026-12-13T03:00:00.000Z', PHX)).toBe('2026-12-12')
    expect(stepStart('2026-12-13T03:00:00.000Z', PHX, 1, '19:00')).toBe('2026-12-12T02:00:00.000Z')
  })
  it('keeps 19:00 local across a daylight-saving change (New York)', () => {
    // Event Sat 2026-03-14 12:00 local (after the 8 March change); steps 14 and 2 days before straddle it.
    const ev = '2026-03-14T16:00:00.000Z'
    expect(stepStart(ev, 'America/New_York', 14, '19:00')).toBe('2026-03-01T00:00:00.000Z') // EST, 19:00 on the 28th... UTC+5
    expect(stepStart(ev, 'America/New_York', 2, '19:00')).toBe('2026-03-12T23:00:00.000Z') // EDT, UTC+4
  })
})

describe('skippedSteps', () => {
  const steps = [
    { title: '60 days', offset_days: 60, local_time: '19:00' },
    { title: '30 days', offset_days: 30, local_time: '19:00' },
    { title: '2 days', offset_days: 2, local_time: '19:00' },
  ]
  it('lists the steps whose date has already passed', () => {
    // "now" is 20 days before the event: the 60 and 30 day steps are gone, the 2 day step is ahead.
    const now = new Date('2026-11-22T12:00:00Z')
    expect(skippedSteps(steps, EVENT, PHX, now)).toEqual(['60 days', '30 days'])
  })
  it('skips nothing when everything is ahead', () => {
    expect(skippedSteps(steps, EVENT, PHX, new Date('2026-09-01T00:00:00Z'))).toEqual([])
  })
})

describe('summarisePlan', () => {
  it('counts what will happen and names what is skipped or left alone', () => {
    const s = summarisePlan([
      { action: 'create', step_title: 'A' },
      { action: 'create', step_title: 'B' },
      { action: 'update', step_title: 'C' },
      { action: 'skip_past', step_title: 'D' },
      { action: 'leave_edited', step_title: 'E' },
      { action: 'unchanged', step_title: 'F' },
    ])
    expect(s).toEqual({ create: 2, update: 1, skipped: ['D'], edited: ['E'] })
  })
})

describe('validateTemplate and toStepsJson', () => {
  const ok = (): TemplateForm => ({ ...emptyTemplateForm(), name: 'Fake Op prep', steps: [{ ...emptyStep(), title: 'Kick-off', offset_days: '60' }] })
  it('accepts a good template', () => expect(validateTemplate(ok())).toEqual({}))
  it('needs a name and at least one step', () => {
    expect(validateTemplate({ ...ok(), name: ' ' }).name).toBeDefined()
    expect(validateTemplate({ ...ok(), steps: [] }).steps).toBeDefined()
  })
  it('an automatic template needs an event type', () => {
    expect(validateTemplate({ ...ok(), auto_apply: true, event_type: '' }).auto_apply).toBeDefined()
    expect(validateTemplate({ ...ok(), auto_apply: true, event_type: 'Op' })).toEqual({})
  })
  it('checks each step and says which one', () => {
    const f = ok()
    f.steps.push({ ...emptyStep(), title: 'Bad', offset_days: '-1' }, { ...emptyStep(), title: '', offset_days: '5' }, { ...emptyStep(), title: 'Short', duration_minutes: '5' })
    expect(Object.keys(validateTemplate(f).step ?? {})).toEqual(['1', '2', '3'])
  })
  it('builds the RPC steps with numbers and nulls', () => {
    expect(toStepsJson([{ ...emptyStep(), title: ' Kick-off ', offset_days: '60', topics: ' ' }])).toEqual([
      { id: null, title: 'Kick-off', offset_days: 60, local_time: '19:00', duration_minutes: 60, audience: 'command', topics: null },
    ])
  })
})

describe('prepTimeline and messages', () => {
  it('collects an event\'s generated meetings in date order', () => {
    const evs = [
      { id: 'b', source_event_id: 'E', starts_at: '2026-12-05T02:00:00Z' },
      { id: 'x', source_event_id: 'OTHER', starts_at: '2026-12-01T02:00:00Z' },
      { id: 'a', source_event_id: 'E', starts_at: '2026-11-12T02:00:00Z' },
      { id: 'c', source_event_id: null, starts_at: '2026-12-01T02:00:00Z' },
    ]
    expect(prepTimeline(evs, 'E').map((e) => e.id)).toEqual(['a', 'b'])
  })
  it('maps database codes and never echoes text', () => {
    expect(cadenceMessage('template_retired')).toMatch(/retired/)
    expect(cadenceMessage('raw')).toMatch(/did not work/)
  })
})
