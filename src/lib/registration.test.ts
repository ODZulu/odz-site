import { describe, expect, it } from 'vitest'
import { fromLocalInput } from './time'
import {
  attendanceOpen,
  placesLine,
  registrationMessage,
  validateConfig,
  windowState,
  withdrawKind,
  type RegistrationInfo,
} from './registration'

const NOW = new Date('2026-11-10T12:00:00Z')
const base: Pick<RegistrationInfo, 'opens_at' | 'closes_at' | 'capacity' | 'registered_count'> = {
  opens_at: '2026-11-01T00:00:00Z',
  closes_at: null,
  capacity: null,
  registered_count: 0,
}
const future = { starts_at: '2026-12-01T00:00:00Z', status: 'scheduled' }

describe('windowState', () => {
  it('is open with no limits', () => expect(windowState(base, future, NOW)).toBe('open'))
  it('is not open before the open time', () => expect(windowState({ ...base, opens_at: '2026-11-20T00:00:00Z' }, future, NOW)).toBe('not_open'))
  it('closes at the close time', () => expect(windowState({ ...base, closes_at: '2026-11-10T11:00:00Z' }, future, NOW)).toBe('closed'))
  it('is full at capacity (new registrants would be waitlisted)', () => {
    expect(windowState({ ...base, capacity: 5, registered_count: 5 }, future, NOW)).toBe('full')
    expect(windowState({ ...base, capacity: 5, registered_count: 4 }, future, NOW)).toBe('open')
  })
  it('is closed once the event starts, or when it is cancelled or completed', () => {
    expect(windowState(base, { starts_at: '2026-11-09T00:00:00Z', status: 'scheduled' }, NOW)).toBe('closed')
    expect(windowState(base, { ...future, status: 'cancelled' }, NOW)).toBe('closed')
    expect(windowState(base, { ...future, status: 'completed' }, NOW)).toBe('closed')
  })
})

describe('withdrawKind', () => {
  const cutoff = '2026-11-20T00:00:00Z'
  it('is free before the cutoff and a request after it', () => {
    expect(withdrawKind('registered', cutoff, NOW)).toBe('withdraw')
    expect(withdrawKind('registered', '2026-11-05T00:00:00Z', NOW)).toBe('request')
  })
  it('lets a waitlisted member leave at any time', () => expect(withdrawKind('waitlisted', '2026-11-05T00:00:00Z', NOW)).toBe('withdraw'))
  it('offers nothing in other states', () => {
    for (const s of ['withdrawal_requested', 'withdrawn', null] as const) expect(withdrawKind(s, cutoff, NOW)).toBe('none')
  })
})

describe('attendanceOpen', () => {
  it('opens when the event has ended, or started when it has no end', () => {
    expect(attendanceOpen({ starts_at: '2026-11-09T00:00:00Z', ends_at: '2026-11-09T04:00:00Z', status: 'scheduled' }, NOW)).toBe(true)
    expect(attendanceOpen({ starts_at: '2026-11-10T08:00:00Z', ends_at: '2026-11-10T16:00:00Z', status: 'scheduled' }, NOW)).toBe(false)
    expect(attendanceOpen({ starts_at: '2026-11-09T00:00:00Z', ends_at: null, status: 'scheduled' }, NOW)).toBe(true)
    expect(attendanceOpen({ starts_at: '2026-11-09T00:00:00Z', ends_at: null, status: 'cancelled' }, NOW)).toBe(false)
  })
})

describe('labels', () => {
  it('describes the places', () => {
    expect(placesLine({ capacity: null, registered_count: 3, waitlist_count: 0 })).toBe('3 registered')
    expect(placesLine({ capacity: 10, registered_count: 3, waitlist_count: 0 })).toBe('3 of 10 places taken')
    expect(placesLine({ capacity: 2, registered_count: 2, waitlist_count: 4 })).toBe('2 of 2 places taken, 4 on the waitlist')
  })
  it('maps database codes and never echoes unknown text', () => {
    expect(registrationMessage('closed')).toMatch(/closed/)
    expect(registrationMessage('weird raw error')).toMatch(/did not work/)
  })
})

describe('validateConfig', () => {
  const starts = '2026-12-01T07:00:00.000Z'
  const ok = { opens: '', closes: '', capacity: '', cutoff: '' }
  it('accepts empty and sensible values', () => {
    expect(validateConfig(ok, starts, fromLocalInput)).toEqual({})
    expect(validateConfig({ opens: '2026-11-01T08:00', closes: '2026-11-20T08:00', capacity: '12', cutoff: '2026-11-24T08:00' }, starts, fromLocalInput)).toEqual({})
  })
  it('rejects bad capacity, window and cutoff', () => {
    expect(validateConfig({ ...ok, capacity: '0' }, starts, fromLocalInput).capacity).toBeDefined()
    expect(validateConfig({ ...ok, capacity: '2.5' }, starts, fromLocalInput).capacity).toBeDefined()
    expect(validateConfig({ ...ok, capacity: '1001' }, starts, fromLocalInput).capacity).toBeDefined()
    expect(validateConfig({ ...ok, opens: '2026-11-20T08:00', closes: '2026-11-10T08:00' }, starts, fromLocalInput).closes).toBeDefined()
    expect(validateConfig({ ...ok, cutoff: '2026-12-02T08:00' }, starts, fromLocalInput).cutoff).toBeDefined()
    expect(validateConfig({ ...ok, opens: 'soon' }, starts, fromLocalInput).opens).toBeDefined()
  })
})
