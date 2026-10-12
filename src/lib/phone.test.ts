import { describe, expect, it } from 'vitest'
import { formatPhoneInput, normalizeAllergies, normalizePhone, validatePhone } from './phone'

describe('normalizePhone', () => {
  it.each([
    '(555) 010-0100',
    '555.010.0100',
    '5550100100',
    '+1 555 010 0100',
    '1-555-010-0100',
    '555-010-0100',
  ])('accepts %s', (p) => expect(normalizePhone(p)).toBe('555-010-0100'))
  it.each(['', '555010010', '55501001000', '555-010-010A', 'abc', '+44 20 7946 0958 1', '2-555-010-0100'])(
    'rejects %j',
    (p) => expect(normalizePhone(p)).toBeNull(),
  )
})

describe('formatPhoneInput', () => {
  it.each([
    ['', ''],
    ['5', '5'],
    ['555', '555'],
    ['5550', '555-0'],
    ['555010', '555-010'],
    ['5550100', '555-010-0'],
    ['5550100100', '555-010-0100'],
    ['555010010099', '555-010-0100'],
    ['(555) 010-0100', '555-010-0100'],
    ['+1 555 010 0100', '555-010-0100'],
    ['55a5', '555'],
  ])('%j -> %j', (raw, out) => expect(formatPhoneInput(raw)).toBe(out))
})

describe('validatePhone', () => {
  it('lets an optional phone be empty', () => expect(validatePhone('  ', false)).toBeNull())
  it('requires a required phone', () => expect(validatePhone('', true)).toMatch(/10-digit/))
  it('says the format on a bad number', () => expect(validatePhone('12345', false)).toMatch(/xxx-xxx-xxxx/))
  it('accepts a pasted number', () => expect(validatePhone('(555) 010-0100', true)).toBeNull())
})

describe('normalizeAllergies', () => {
  it.each(['None', ' n/a ', 'NKA', 'nka', 'No', 'nil', 'NA'])('%j becomes NKA', (a) =>
    expect(normalizeAllergies(a)).toBe('NKA'),
  )
  it.each([
    ['Penicillin', 'Penicillin'],
    ['  Peanuts ', 'Peanuts'],
    ['none of the above', 'none of the above'],
  ])('%j stays %j', (a, out) => expect(normalizeAllergies(a)).toBe(out))
})
