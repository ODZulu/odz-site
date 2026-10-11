import { describe, expect, it } from 'vitest'
import {
  inviteCodeShapeOk,
  normalizeInviteCode,
  validateCallsign,
  validateDob,
  validatePassword,
  validatePhone,
  validateSetup,
  type SetupValues,
} from './validate'

const today = new Date(2026, 9, 10)

// Obviously fake values only: the repo is public.
const good: SetupValues = {
  callsign: 'Sample-1',
  legalName: 'Sample Person',
  dob: '1990-05-17',
  phone: '',
  allergies: 'None',
  emergencyName: 'Sample Contact',
  emergencyRelationship: 'Friend',
  emergencyPhone: '555-010-0100',
}

describe('invite codes', () => {
  it('ignores case, spaces and dashes', () => {
    expect(normalizeInviteCode('AbCdE-12345 fGhIj')).toBe('abcde12345fghij')
  })
  it('needs at least 10 characters of shape', () => {
    expect(inviteCodeShapeOk('abc')).toBe(false)
    expect(inviteCodeShapeOk('abcde-12345')).toBe(true)
  })
})

describe('password', () => {
  it('needs 12 characters', () => {
    expect(validatePassword('a'.repeat(11))).not.toBeNull()
    expect(validatePassword('a'.repeat(12))).toBeNull()
  })
})

describe('callsign', () => {
  it.each(['AB', 'Fox-Trot_9', 'two words', 'a'.repeat(24)])('accepts %s', (c) =>
    expect(validateCallsign(c)).toBeNull(),
  )
  it.each(['A', 'a'.repeat(25), 'bad!', ' lead', 'trail ', 'accenté', ''])('rejects %j', (c) =>
    expect(validateCallsign(c)).not.toBeNull(),
  )
})

describe('date of birth', () => {
  it('accepts a real past date', () => expect(validateDob('1990-05-17', today)).toBeNull())
  it('accepts today', () => expect(validateDob('2026-10-10', today)).toBeNull())
  it('rejects the future', () => expect(validateDob('2026-10-11', today)).not.toBeNull())
  it('rejects impossible dates', () => {
    expect(validateDob('2023-02-30', today)).not.toBeNull()
    expect(validateDob('2023-13-01', today)).not.toBeNull()
  })
  it('rejects blanks and junk', () => {
    expect(validateDob('', today)).not.toBeNull()
    expect(validateDob('17/05/1990', today)).not.toBeNull()
    expect(validateDob('1850-01-01', today)).not.toBeNull()
  })
})

describe('phone', () => {
  it('is optional when not required', () => expect(validatePhone('  ', false)).toBeNull())
  it('is required when required', () => expect(validatePhone('', true)).not.toBeNull())
  it.each(['555 010 0100', '+1 (555) 010-0100', '5550100100'])('accepts %s', (p) =>
    expect(validatePhone(p, true)).toBeNull(),
  )
  it.each(['abc', '12345', '555-CALL-NOW', '1'.repeat(25)])('rejects %s', (p) =>
    expect(validatePhone(p, true)).not.toBeNull(),
  )
})

describe('setup form', () => {
  it('passes a complete form (phone optional)', () => expect(validateSetup(good, today)).toEqual({}))
  it('requires every mandatory field', () => {
    const errors = validateSetup(
      {
        ...good,
        callsign: '',
        legalName: ' ',
        dob: '',
        allergies: '',
        emergencyName: '',
        emergencyRelationship: '',
        emergencyPhone: '',
      },
      today,
    )
    expect(Object.keys(errors).sort()).toEqual(
      ['allergies', 'callsign', 'dob', 'emergencyName', 'emergencyPhone', 'emergencyRelationship', 'legalName'].sort(),
    )
  })
  it('checks an optional phone when given', () => expect(validateSetup({ ...good, phone: 'x' }, today).phone).toBeDefined())
  it('never echoes values in messages', () => {
    const errors = validateSetup({ ...good, dob: '2999-01-01', emergencyPhone: 'fake-secret' }, today)
    expect(JSON.stringify(errors)).not.toMatch(/2999|fake-secret/)
  })
})
