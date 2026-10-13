import { describe, expect, it } from 'vitest'
import { confirmsCallsign, removalBlock, validateReason } from './removal'

describe('validateReason', () => {
  it('requires a reason', () => {
    expect(validateReason('')).not.toBeNull()
    expect(validateReason('   ')).not.toBeNull()
    expect(validateReason('ab')).not.toBeNull()
  })
  it('accepts 3 to 500 characters after trimming', () => {
    expect(validateReason('  abc  ')).toBeNull()
    expect(validateReason('r'.repeat(500))).toBeNull()
    expect(validateReason('r'.repeat(501))).not.toBeNull()
  })
})

describe('removalBlock', () => {
  const target = { id: 't1', is_admin: false, status: 'approved' }
  const base = { isAdmin: true, selfId: 'me', target, approvedAdmins: 2 }

  it('offers removal to an Admin', () => expect(removalBlock(base)).toBeNull())
  it('never offers it to a non-Admin, Command included', () =>
    expect(removalBlock({ ...base, isAdmin: false })).toMatch(/Only an Admin/))
  it('blocks removing yourself', () => expect(removalBlock({ ...base, target: { ...target, id: 'me' } })).toMatch(/yourself/))
  it('blocks the last Admin', () => {
    const admin = { ...target, is_admin: true }
    expect(removalBlock({ ...base, target: admin, approvedAdmins: 1 })).toMatch(/one Admin/)
    expect(removalBlock({ ...base, target: admin, approvedAdmins: 2 })).toBeNull()
  })
  it('does not offer a second removal', () =>
    expect(removalBlock({ ...base, target: { ...target, status: 'removed' } })).toMatch(/already removed/))
})

describe('confirmsCallsign', () => {
  it('needs the exact callsign', () => {
    expect(confirmsCallsign('Fake-Mem', 'Fake-Mem')).toBe(true)
    expect(confirmsCallsign('  Fake-Mem ', 'Fake-Mem')).toBe(true)
    expect(confirmsCallsign('fake-mem', 'Fake-Mem')).toBe(false)
    expect(confirmsCallsign('', 'Fake-Mem')).toBe(false)
  })
  it('never matches a member with no callsign', () => {
    expect(confirmsCallsign('', null)).toBe(false)
    expect(confirmsCallsign('', '')).toBe(false)
  })
})
