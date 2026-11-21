import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

import { groupScheduleByDay, idFromHash, loadProspects, mergeSchedule, prospectAnchor, prospectHref, upcomingProspects } from './prospects'
import type { Opportunity } from './opportunities'

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Fake Opportunity',
  host: null,
  source_url: null,
  starts_on: '2030-03-09',
  ends_on: null,
  location_text: null,
  latitude: null,
  longitude: null,
  est_cost_cents: null,
  notes: null,
  status: 'open',
  created_by: null,
  creator_callsign: null,
  event_id: null,
  drop_reason: null,
  in_count: 0,
  maybe_count: 0,
  out_count: 0,
  my_response: null,
  ...over,
})

// Noon Phoenix on 2030-03-08 (UTC-7, no daylight saving).
const now = new Date('2030-03-08T19:00:00Z')

describe('upcomingProspects', () => {
  it('keeps only open, unfinished opportunities, soonest first', () => {
    const rows = [
      opp({ id: 'c', title: 'Later', starts_on: '2030-04-01' }),
      opp({ id: 'a', title: 'Sooner', starts_on: '2030-03-09' }),
      opp({ id: 'p', status: 'promoted' }),
      opp({ id: 'd', status: 'dropped' }),
      opp({ id: 'x', status: 'expired' }),
      opp({ id: 'old', starts_on: '2030-03-01' }),
    ]
    expect(upcomingProspects(rows, now).map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('keeps a multi-day one that started but has not ended, and drops it the day after it ends', () => {
    const rows = [opp({ id: 'm', starts_on: '2030-03-07', ends_on: '2030-03-09' })]
    expect(upcomingProspects(rows, now)).toHaveLength(1)
    expect(upcomingProspects(rows, new Date('2030-03-10T19:00:00Z'))).toHaveLength(0)
  })

  it('treats the day an opportunity starts as still upcoming, by Phoenix date', () => {
    const rows = [opp({ starts_on: '2030-03-08' })]
    // 23:30 Phoenix on the 8th is already the 9th in UTC.
    expect(upcomingProspects(rows, new Date('2030-03-09T06:30:00Z'))).toHaveLength(1)
  })

  it('exposes only the schedule fields, never counts or answers', () => {
    const [p] = upcomingProspects([opp({ in_count: 4, my_response: 'In' })], now)
    expect(Object.keys(p).sort()).toEqual(['ends_on', 'id', 'location_text', 'starts_on', 'title'])
  })
})

describe('mergeSchedule', () => {
  const ev = (id: string, starts_at: string) => ({ id, starts_at })
  const prospects = upcomingProspects([opp({ id: 'p1', starts_on: '2030-03-10' }), opp({ id: 'p2', starts_on: '2030-03-12' })], now)

  it('orders events and prospects by day, events first within a day', () => {
    const merged = mergeSchedule(
      [ev('e1', '2030-03-10T16:00:00Z'), ev('e2', '2030-03-11T16:00:00Z')],
      prospects,
      now,
    )
    expect(merged.map((i) => (i.kind === 'event' ? i.event.id : i.prospect.id))).toEqual(['e1', 'p1', 'e2', 'p2'])
  })

  it('keeps a prospect after an event on the same day even when the event is late', () => {
    const merged = mergeSchedule([ev('late', '2030-03-11T05:00:00Z')], upcomingProspects([opp({ id: 'p', starts_on: '2030-03-10' })], now), now)
    // 2030-03-11T05:00Z is 22:00 Phoenix on the 10th.
    expect(merged.map((i) => i.kind)).toEqual(['event', 'prospect'])
  })

  it('places an in-progress multi-day prospect on today', () => {
    const p = upcomingProspects([opp({ id: 'm', starts_on: '2030-03-06', ends_on: '2030-03-09' })], now)
    expect(mergeSchedule([], p, now)[0].day).toBe('2030-03-08')
  })

  it('never turns a prospect into an event', () => {
    const merged = mergeSchedule([], prospects, now)
    expect(merged.every((i) => i.kind === 'prospect')).toBe(true)
  })
})

describe('groupScheduleByDay', () => {
  it('groups by day in order', () => {
    const merged = mergeSchedule([{ starts_at: '2030-03-10T16:00:00Z' }], upcomingProspects([opp({ starts_on: '2030-03-10' }), opp({ id: 'z', starts_on: '2030-03-12' })], now), now)
    const groups = groupScheduleByDay(merged)
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([['2030-03-10', 2], ['2030-03-12', 1]])
  })
})

describe('deep link', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  it('round-trips an id through the href and the hash', () => {
    expect(prospectHref(id)).toBe(`/opportunities#${prospectAnchor(id)}`)
    expect(idFromHash(`#${prospectAnchor(id)}`)).toBe(id)
  })
  it('ignores anything that is not an opportunity anchor', () => {
    expect(idFromHash('')).toBeNull()
    expect(idFromHash('#opp-<script>')).toBeNull()
    expect(idFromHash('#other')).toBeNull()
  })
})

describe('loadProspects', () => {
  it('returns nothing, not an error, when there is no backend', async () => {
    expect(await loadProspects(now)).toEqual([])
  })
})
