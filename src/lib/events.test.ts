import { describe, expect, it, vi } from 'vitest'

// The events module imports the Supabase client; keep these tests independent of local env files.
vi.mock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

import { emptyEventForm, groupByDay, isPast, splitUpcoming, toRow, validateEventForm, type EventForm } from './events'

const good: EventForm = {
  ...emptyEventForm,
  title: 'Fake Training',
  event_type: 'Training',
  starts: '2026-10-17T06:30',
  ends: '2026-10-17T10:00',
}

describe('validateEventForm', () => {
  it('accepts a complete form', () => expect(validateEventForm(good)).toEqual({}))
  it('needs a title', () => expect(validateEventForm({ ...good, title: '  ' }).title).toBeDefined())
  it('needs a start', () => expect(validateEventForm({ ...good, starts: '' }).starts).toBeDefined())
  it('end must be after start', () => {
    expect(validateEventForm({ ...good, ends: '2026-10-17T06:30' }).ends).toBeDefined()
    expect(validateEventForm({ ...good, ends: '2026-10-17T05:00' }).ends).toBeDefined()
  })
  it('end is optional', () => expect(validateEventForm({ ...good, ends: '' })).toEqual({}))
  it('limits the long fields', () => {
    expect(validateEventForm({ ...good, location_detail: 'x'.repeat(1001) }).location_detail).toBeDefined()
    expect(validateEventForm({ ...good, description: 'x'.repeat(5001) }).description).toBeDefined()
  })
})

describe('toRow', () => {
  it('converts Phoenix wall-clock input to UTC and trims', () => {
    const row = toRow({ ...good, title: '  Fake Training ', location_name: ' ' })
    expect(row.starts_at).toBe('2026-10-17T13:30:00.000Z')
    expect(row.ends_at).toBe('2026-10-17T17:00:00.000Z')
    expect(row.title).toBe('Fake Training')
    expect(row.location_name).toBeNull()
  })
})

describe('past and upcoming', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  const mk = (starts_at: string, ends_at: string | null = null) => ({ starts_at, ends_at })
  it('an event with no end is past once it has started', () => {
    expect(isPast(mk('2026-10-10T11:00:00Z'), now)).toBe(true)
    expect(isPast(mk('2026-10-10T13:00:00Z'), now)).toBe(false)
  })
  it('an event in progress is not past', () => {
    expect(isPast(mk('2026-10-10T10:00:00Z', '2026-10-10T14:00:00Z'), now)).toBe(false)
  })
  it('sorts upcoming soonest first and past most recent first', () => {
    const a = mk('2026-10-12T00:00:00Z')
    const b = mk('2026-10-11T00:00:00Z')
    const c = mk('2026-10-01T00:00:00Z')
    const d = mk('2026-10-05T00:00:00Z')
    const { upcoming, past } = splitUpcoming([a, c, b, d], now)
    expect(upcoming).toEqual([b, a])
    expect(past).toEqual([d, c])
  })
})

describe('groupByDay', () => {
  it('groups by Phoenix day', () => {
    // 02:00Z on the 11th is the evening of the 10th in Phoenix.
    const groups = groupByDay([
      { starts_at: '2026-10-11T02:00:00Z' },
      { starts_at: '2026-10-10T20:00:00Z' },
      { starts_at: '2026-10-11T15:00:00Z' },
    ])
    expect(groups.map((g) => [g.key, g.events.length])).toEqual([
      ['2026-10-10', 2],
      ['2026-10-11', 1],
    ])
  })
  it('merges neighbours on the same day', () => {
    const groups = groupByDay([{ starts_at: '2026-10-10T15:00:00Z' }, { starts_at: '2026-10-10T20:00:00Z' }])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('SAT 10 OCT 2026')
  })
})
