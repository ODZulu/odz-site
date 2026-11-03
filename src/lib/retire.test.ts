import { describe, expect, it } from 'vitest'
import {
  isSeatFull,
  retireBlock,
  retireMessage,
  retireWarning,
  returnTierOptions,
  validateRetireReason,
  type TierOption,
} from './retire'

const target = { id: 't1', is_admin: false, status: 'approved' }
const ok = { canEdit: true, isAdmin: false, selfId: 'me', target }

describe('validateRetireReason', () => {
  it('is optional', () => {
    expect(validateRetireReason('')).toBeNull()
    expect(validateRetireReason('   ')).toBeNull()
  })
  it('caps at 300 characters after trimming', () => {
    expect(validateRetireReason('x'.repeat(300))).toBeNull()
    expect(validateRetireReason(' ' + 'x'.repeat(300) + ' ')).toBeNull()
    expect(validateRetireReason('x'.repeat(301))).toMatch(/300/)
  })
})

describe('retireBlock', () => {
  it('offers the action to Command on an active member', () => expect(retireBlock(ok)).toBeNull())
  it('also offers it for a suspended member', () =>
    expect(retireBlock({ ...ok, target: { ...target, status: 'suspended' } })).toBeNull())
  it('hides it from anyone without edit_roster', () => expect(retireBlock({ ...ok, canEdit: false })).toMatch(/Command or an Admin/))
  it('refuses yourself', () => expect(retireBlock({ ...ok, selfId: 't1' })).toMatch(/yourself/))
  it('refuses a member who is already retired, pending, or removed', () => {
    expect(retireBlock({ ...ok, target: { ...target, status: 'retired' } })).toMatch(/already retired/)
    expect(retireBlock({ ...ok, target: { ...target, status: 'pending' } })).toMatch(/active member/)
    expect(retireBlock({ ...ok, target: { ...target, status: 'removed' } })).toMatch(/active member/)
  })
  it('lets only an Admin retire an Admin', () => {
    expect(retireBlock({ ...ok, target: { ...target, is_admin: true } })).toMatch(/Only an Admin/)
    expect(retireBlock({ ...ok, isAdmin: true, target: { ...target, is_admin: true } })).toBeNull()
  })
})

describe('retireWarning', () => {
  it('lists the designations that will be vacated first', () => {
    const w = retireWarning('Fake-A', ['Quartermaster', 'Treasurer'])
    expect(w.startsWith('Fake-A will lose these designations')).toBe(true)
    expect(w).toContain('Quartermaster, Treasurer')
    expect(w).toContain('not restored on return')
  })
  it('says nothing about designations when there are none', () => {
    const w = retireWarning('Fake-A', [])
    expect(w).not.toContain('designations')
    expect(w).toContain('service record is kept')
  })
})

const tiers: TierOption[] = [
  { id: 'cmd', name: 'Command', rank: 1, seat_group: 'command', role_based: false, entry_requires_tier_id: 'og' },
  { id: 'og', name: 'Old Guard', rank: 2, seat_group: 'old_guard', role_based: false, entry_requires_tier_id: null },
  { id: 'mem', name: 'Member', rank: 3, seat_group: null, role_based: false, entry_requires_tier_id: null },
  { id: 'sup', name: 'Support', rank: 9, seat_group: null, role_based: true, entry_requires_tier_id: null },
]
const counts = (og: number, cmd: number) => ({ old_guard_count: og, old_guard_max: 12, command_count: cmd, command_max: 3 })

describe('returnTierOptions', () => {
  it('offers player tiers other than the one that was full, never Support', () => {
    const o = returnTierOptions({ tiers, counts: counts(12, 3), currentTierId: 'og' })
    expect(o.map((t) => t.id)).toEqual(['mem'])
  })
  it('offers Old Guard again once a seat opens', () => {
    expect(returnTierOptions({ tiers, counts: counts(11, 3), currentTierId: 'mem' }).map((t) => t.id)).toEqual(['og'])
  })
  it('does not offer Command when its seats are full or its entry rule is not met', () => {
    expect(returnTierOptions({ tiers, counts: counts(10, 3), currentTierId: 'og' }).map((t) => t.id)).toEqual(['mem'])
    expect(returnTierOptions({ tiers, counts: counts(10, 2), currentTierId: 'mem' }).map((t) => t.id)).toEqual(['og'])
  })
  it('offers Command to a member coming from Old Guard when Command has room', () => {
    const o = returnTierOptions({ tiers, counts: counts(5, 1), currentTierId: 'og' })
    expect(o.map((t) => t.id)).toEqual(['cmd', 'mem'])
  })
  it('works without counts (the database still decides)', () => {
    expect(returnTierOptions({ tiers, counts: null, currentTierId: 'mem' }).map((t) => t.id)).toEqual(['og'])
  })
})

describe('retireMessage / isSeatFull', () => {
  it('translates the fixed codes', () => {
    expect(retireMessage({ message: 'cannot_retire_self' })).toMatch(/yourself/)
    expect(retireMessage({ message: 'not_active' })).toMatch(/active/)
    expect(retireMessage({ message: 'not_retired' })).toMatch(/not retired/)
    expect(retireMessage({ message: 'invalid_tier' })).toMatch(/tier/)
    expect(retireMessage({ message: 'invalid_reason' })).toMatch(/300/)
    expect(retireMessage({ message: 'not allowed' })).toBeTruthy()
  })
  it('uses the seat-full text and never passes unknown text through', () => {
    expect(retireMessage({ message: 'Old Guard is full: 12/12' })).toBe('Old Guard is full: 12/12')
    expect(retireMessage({ message: 'Failing row contains (secret)' })).toBe('That change was refused.')
  })
  it('names a missing migration', () => {
    expect(retireMessage({ message: 'Could not find the function public.retire_member in the schema cache' })).toMatch(/migration/)
  })
  it('detects a full seat', () => {
    expect(isSeatFull({ message: 'Command is full: 3/3' })).toBe(true)
    expect(isSeatFull({ message: 'not allowed' })).toBe(false)
    expect(isSeatFull(null)).toBe(false)
  })
})
