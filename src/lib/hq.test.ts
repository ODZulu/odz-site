import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

import { breakdownBars, canRsvp, groupRsvps, readinessParts, readinessSummary, sortTraffic, validateTraffic, type Readiness, type RsvpRow } from './hq'

describe('sortTraffic', () => {
  it('puts pinned first, then newest first', () => {
    const posts = [
      { id: 'a', pinned: false, created_at: '2026-10-03T00:00:00Z' },
      { id: 'b', pinned: true, created_at: '2026-10-01T00:00:00Z' },
      { id: 'c', pinned: false, created_at: '2026-10-05T00:00:00Z' },
      { id: 'd', pinned: true, created_at: '2026-10-02T00:00:00Z' },
    ]
    expect(sortTraffic(posts).map((p) => p.id)).toEqual(['d', 'b', 'c', 'a'])
  })
})

describe('validateTraffic', () => {
  it('accepts the limits', () => expect(validateTraffic({ title: 't'.repeat(80), body: 'b'.repeat(1000) })).toEqual({}))
  it('rejects blanks and overruns', () => {
    expect(Object.keys(validateTraffic({ title: ' ', body: '' })).sort()).toEqual(['body', 'title'])
    expect(Object.keys(validateTraffic({ title: 't'.repeat(81), body: 'b'.repeat(1001) })).sort()).toEqual(['body', 'title'])
  })
})

describe('readiness', () => {
  const r: Readiness = { eligible: 8, in_count: 4, out_count: 1, tbd_count: 2, no_response: 1 }
  it('summarises in over eligible', () => {
    expect(readinessSummary(r)).toEqual({ text: '4 / 8 IN', percent: 50 })
  })
  it('guards an empty roster', () => {
    expect(readinessSummary({ eligible: 0, in_count: 0, out_count: 0, tbd_count: 0, no_response: 0 })).toEqual({ text: '0 / 0 IN', percent: 0 })
  })
  it('builds meter segments in order and drops empty ones', () => {
    expect(readinessParts(r).map((p) => [p.kind, p.count])).toEqual([['go', 4], ['pending', 2], ['alert', 1], ['none', 1]])
    expect(readinessParts({ ...r, tbd_count: 0, no_response: 0 }).map((p) => p.kind)).toEqual(['go', 'alert'])
  })
  it('segments add up to the eligible count', () => {
    expect(readinessParts(r).reduce((n, p) => n + p.count, 0)).toBe(r.eligible)
  })
})

describe('groupRsvps', () => {
  it('groups callsigns by answer, sorted, skipping members with no callsign', () => {
    const rows: RsvpRow[] = [
      { profile_id: '1', response: 'in', profile: { callsign: 'Zulu' } },
      { profile_id: '2', response: 'in', profile: { callsign: 'alpha' } },
      { profile_id: '3', response: 'out', profile: { callsign: 'Bravo' } },
      { profile_id: '4', response: 'tbd', profile: { callsign: null } },
      { profile_id: '5', response: 'tbd', profile: null },
    ]
    expect(groupRsvps(rows)).toEqual({ in: ['alpha', 'Zulu'], out: ['Bravo'], tbd: [] })
  })
})

describe('canRsvp', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  it('is open before the start of a scheduled event', () => {
    expect(canRsvp({ starts_at: '2026-10-10T13:00:00Z', status: 'scheduled' }, now)).toBe(true)
  })
  it('closes at the start', () => {
    expect(canRsvp({ starts_at: '2026-10-10T12:00:00Z', status: 'scheduled' }, now)).toBe(false)
    expect(canRsvp({ starts_at: '2026-10-10T11:00:00Z', status: 'scheduled' }, now)).toBe(false)
  })
  it('is closed for a cancelled event', () => {
    expect(canRsvp({ starts_at: '2026-10-11T00:00:00Z', status: 'cancelled' }, now)).toBe(false)
  })
})

describe('breakdownBars', () => {
  it('sorts by rank and scales to the largest tier', () => {
    const bars = breakdownBars([
      { tier_name: 'Member', tier_rank: 3, member_count: 4 },
      { tier_name: 'Command', tier_rank: 1, member_count: 2 },
      { tier_name: 'Recruit', tier_rank: 6, member_count: 0 },
    ])
    expect(bars.map((b) => b.tier_name)).toEqual(['Command', 'Member', 'Recruit'])
    expect(bars.map((b) => b.share)).toEqual([0.5, 1, 0])
  })
  it('does not divide by zero when nobody is on the roster', () => {
    expect(breakdownBars([{ tier_name: 'Command', tier_rank: 1, member_count: 0 }])[0].share).toBe(0)
  })
})
