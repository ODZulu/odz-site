import { describe, expect, it } from 'vitest'
import {
  adminMessage,
  confirmMatches,
  groupCode,
  holdersOf,
  joinLink,
  maskCode,
  moveId,
  needsTypedConfirm,
  removalLocksOut,
  toggleCap,
  validateExpiryDays,
  visibleSections,
  type CapMatrix,
} from './admin'

const matrix: CapMatrix = {
  cmd: ['approve_members', 'edit_roster', 'view_member_private'],
  mem: ['read_minutes'],
  rec: [],
}

describe('invite display', () => {
  it('masks all but the last four characters', () => expect(maskCode('ab12')).toBe('**** **** **** ab12'))
  it('groups a code for reading aloud', () => expect(groupCode('abcdefghij')).toBe('abcd-efgh-ij'))
  it('builds a join link without doubling slashes', () => {
    expect(joinLink('https://example.invalid/', 'abc')).toBe('https://example.invalid/join/abc')
  })
})

describe('expiry days', () => {
  it.each([1, 7, 30])('accepts %i', (d) => expect(validateExpiryDays(d)).toBeNull())
  it.each([0, 31, -1, 2.5, Number.NaN])('rejects %s', (d) => expect(validateExpiryDays(d)).not.toBeNull())
})

describe('capability matrix', () => {
  it('lists holders', () => expect(holdersOf(matrix, 'approve_members')).toEqual(['cmd']))
  it('toggles on and off without mutating', () => {
    const on = toggleCap(matrix, 'mem', 'write_events', true)
    expect(on.mem).toEqual(['read_minutes', 'write_events'])
    expect(matrix.mem).toEqual(['read_minutes'])
    expect(toggleCap(on, 'mem', 'write_events', false).mem).toEqual(['read_minutes'])
  })
  it('does not duplicate a capability', () => {
    expect(toggleCap(matrix, 'cmd', 'edit_roster', true).cmd).toHaveLength(3)
  })
  it('refuses to strip approve_members from the last tier that has it', () => {
    expect(removalLocksOut(matrix, 'cmd', 'approve_members')).toBe(true)
  })
  it('allows it once another tier holds it', () => {
    const two = toggleCap(matrix, 'mem', 'approve_members', true)
    expect(removalLocksOut(two, 'cmd', 'approve_members')).toBe(false)
  })
  it('only guards approve_members', () => expect(removalLocksOut(matrix, 'cmd', 'edit_roster')).toBe(false))
})

describe('typed confirmation', () => {
  it('is only needed for private details', () => {
    expect(needsTypedConfirm('view_member_private')).toBe(true)
    expect(needsTypedConfirm('write_events')).toBe(false)
  })
  it('is exact and case-sensitive', () => {
    expect(confirmMatches('PRIVATE')).toBe(true)
    expect(confirmMatches('private')).toBe(false)
    expect(confirmMatches(' PRIVATE')).toBe(false)
  })
})

describe('moveId', () => {
  const ids = ['a', 'b', 'c']
  it('moves up and down', () => {
    expect(moveId(ids, 'b', 'up')).toEqual(['b', 'a', 'c'])
    expect(moveId(ids, 'b', 'down')).toEqual(['a', 'c', 'b'])
  })
  it('stops at the ends and ignores unknown ids', () => {
    expect(moveId(ids, 'a', 'up')).toEqual(ids)
    expect(moveId(ids, 'c', 'down')).toEqual(ids)
    expect(moveId(ids, 'x', 'up')).toEqual(ids)
  })
})

describe('visibleSections', () => {
  it('shows nothing to a plain member', () => expect(visibleSections(['read_minutes'], false)).toEqual([]))
  it('gives Command invites, pending, members and audit but not tiers', () => {
    expect(visibleSections(['approve_members', 'edit_roster'], false)).toEqual(['invites', 'pending', 'members', 'audit'])
  })
  it('gives an approver without edit_roster no members tab', () => {
    expect(visibleSections(['approve_members'], false)).toEqual(['invites', 'pending', 'audit'])
  })
  it('gives Admin everything', () => {
    expect(visibleSections([], true)).toEqual(['invites', 'pending', 'members', 'tiers', 'audit'])
  })
})

describe('adminMessage', () => {
  it('translates known refusals', () => {
    expect(adminMessage({ message: 'approve_members_lockout' })).toMatch(/at least one tier/)
    expect(adminMessage({ message: 'tier_has_members' })).toMatch(/members/)
    expect(adminMessage({ message: 'cannot change your own tier' })).toMatch(/own tier/)
  })
  it('translates the removal refusals', () => {
    expect(adminMessage({ message: 'last_admin' })).toMatch(/one admin/)
    expect(adminMessage({ message: 'cannot_remove_self' })).toMatch(/yourself/)
    expect(adminMessage({ message: 'invalid_reason' })).toMatch(/reason/)
    expect(adminMessage({ message: 'account was removed' })).toMatch(/removed/)
  })
  it('never passes unknown text through', () => {
    expect(adminMessage({ message: 'Failing row contains (1990-01-01)' })).toBe('That change was refused.')
    expect(adminMessage(null)).toBe('That change was refused.')
  })
})
