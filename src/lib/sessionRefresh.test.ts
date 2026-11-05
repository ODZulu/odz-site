import { describe, expect, it } from 'vitest'
import { FOCUS_MIN_MS, INTERVAL_MS, mustSignOut, ROUTE_MIN_MS, sameSnapshot, shouldRefresh } from './sessionRefresh'

describe('shouldRefresh', () => {
  it('refreshes on focus unless a read just happened', () => {
    expect(shouldRefresh('focus', 10_000, 10_000 - FOCUS_MIN_MS)).toBe(true)
    expect(shouldRefresh('focus', 10_000, 9_000)).toBe(false)
  })
  it('refreshes on a route change only after more than 60 seconds', () => {
    expect(shouldRefresh('route', 100_000, 100_000 - ROUTE_MIN_MS)).toBe(false)
    expect(shouldRefresh('route', 100_000, 100_000 - ROUTE_MIN_MS - 1)).toBe(true)
  })
  it('refreshes on the interval once 5 minutes have passed', () => {
    expect(shouldRefresh('interval', 1_000_000, 1_000_000 - INTERVAL_MS + 1)).toBe(false)
    expect(shouldRefresh('interval', 1_000_000, 1_000_000 - INTERVAL_MS)).toBe(true)
  })
})

describe('mustSignOut', () => {
  it('signs out suspended and removed only', () => {
    expect(mustSignOut('suspended')).toBe(true)
    expect(mustSignOut('removed')).toBe(true)
    for (const s of ['approved', 'pending', 'retired'] as const) expect(mustSignOut(s)).toBe(false)
    expect(mustSignOut(null)).toBe(false)
  })
})

describe('sameSnapshot', () => {
  const base = { profile: { callsign: 'Fake', status: 'approved', setup_complete: true, is_admin: false, tier_id: 't1' }, tierName: 'Command', capabilities: ['a', 'b'] }
  it('is true for equal content in any capability order', () => {
    expect(sameSnapshot(base, { ...base, capabilities: ['b', 'a'] })).toBe(true)
  })
  it('detects a tier, admin, status or capability change', () => {
    expect(sameSnapshot(base, { ...base, tierName: 'Member' })).toBe(false)
    expect(sameSnapshot(base, { ...base, profile: { ...base.profile, is_admin: true } })).toBe(false)
    expect(sameSnapshot(base, { ...base, profile: { ...base.profile, status: 'retired' } })).toBe(false)
    expect(sameSnapshot(base, { ...base, capabilities: ['a'] })).toBe(false)
    expect(sameSnapshot(base, { ...base, profile: null })).toBe(false)
  })
})
