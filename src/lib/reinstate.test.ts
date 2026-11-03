import { describe, expect, it } from 'vitest'
import { reinstateMessage, reinstateNotice, reinstatedTierName, validateReason } from './reinstate'

describe('reinstatedTierName', () => {
  it('returns Old Guard and Command members as Member (seats come back only through promotion)', () => {
    expect(reinstatedTierName({ name: 'Old Guard', seat_group: 'old_guard' })).toBe('Member')
    expect(reinstatedTierName({ name: 'Command', seat_group: 'command' })).toBe('Member')
  })
  it('restores every other tier', () => {
    for (const name of ['Member', 'Prospect', 'Recruit', 'Contractor', 'Support']) {
      expect(reinstatedTierName({ name, seat_group: null })).toBe(name)
    }
  })
  it('falls back to Member when the previous tier is unknown', () => expect(reinstatedTierName(null)).toBe('Member'))
})

describe('validateReason (shared with removal)', () => {
  it('needs 3 to 500 characters after trimming', () => {
    expect(validateReason('ab')).toMatch(/at least 3/)
    expect(validateReason('  ab  ')).toMatch(/at least 3/)
    expect(validateReason('abc')).toBeNull()
    expect(validateReason('x'.repeat(500))).toBeNull()
    expect(validateReason('x'.repeat(501))).toMatch(/500/)
  })
})

describe('reinstateNotice', () => {
  it('says which tier they return as, and that a lost seat needs a promotion', () => {
    const n = reinstateNotice('Fake-A', { name: 'Old Guard', seat_group: 'old_guard' })
    expect(n).toContain('returns as Member')
    expect(n).toContain('Old Guard seat is not restored')
    expect(n).toContain('first-login setup')
    expect(n).toContain('Designations are not restored')
  })
  it('does not mention a seat for an ordinary tier', () => {
    const n = reinstateNotice('Fake-A', { name: 'Recruit', seat_group: null })
    expect(n).toContain('returns as Recruit')
    expect(n).not.toContain('seat is not restored')
  })
})

describe('reinstateMessage', () => {
  it('translates the fixed codes', () => {
    expect(reinstateMessage({ message: 'not_reinstatable' })).toMatch(/removed member/)
    expect(reinstateMessage({ message: 'invalid_reason' })).toMatch(/reason/)
    expect(reinstateMessage({ message: 'not_found' })).toMatch(/not found/)
    expect(reinstateMessage({ message: 'not allowed' })).toBeTruthy()
  })
  it('names a missing migration and never passes unknown text through', () => {
    expect(reinstateMessage({ message: 'Could not find the function public.reinstate_member in the schema cache' })).toMatch(/migration/)
    expect(reinstateMessage({ message: 'Failing row contains (secret)' })).toBe('That change was refused.')
  })
})
