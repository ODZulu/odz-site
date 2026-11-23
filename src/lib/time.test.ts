import { describe, expect, it } from 'vitest'
import { dayKey, formatDateLine, formatDayShort, formatPlainDate, formatStampPhoenix, formatTimeL, formatWhen, fromLocalInput, toLocalInput } from './time'

describe('Phoenix time', () => {
  // 2026-10-10 13:30 UTC is 06:30 in Phoenix (UTC-7, no daylight saving).
  const instant = '2026-10-10T13:30:00Z'

  it('formats 24-hour with an L suffix', () => expect(formatTimeL(instant)).toBe('0630L'))
  it('zero-pads midnight and never shows 24', () => {
    expect(formatTimeL('2026-10-10T07:00:00Z')).toBe('0000L')
    expect(formatTimeL('2026-10-10T06:59:00Z')).toBe('2359L')
  })
  it('has no daylight saving: summer and winter offsets match', () => {
    expect(formatTimeL('2026-07-01T13:30:00Z')).toBe('0630L')
    expect(formatTimeL('2026-01-01T13:30:00Z')).toBe('0630L')
  })
  it('formats the date line', () => expect(formatDateLine(instant)).toBe('SAT 10 OCT 2026'))
  it('formats the compact stamp', () => expect(formatStampPhoenix(instant)).toBe('10OCT26 0630L'))
  it('uses the Phoenix day, not the UTC day', () => {
    expect(dayKey('2026-10-11T02:00:00Z')).toBe('2026-10-10')
    expect(formatTimeL('2026-10-11T02:00:00Z')).toBe('1900L')
  })
})

describe('datetime-local round trip', () => {
  it('reads a local value as Phoenix time', () => {
    expect(fromLocalInput('2026-10-10T06:30')).toBe('2026-10-10T13:30:00.000Z')
  })
  it('round trips', () => {
    const iso = '2026-12-31T23:15:00.000Z'
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso)
  })
  it('rejects junk', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('2026-10-10')).toBeNull()
    expect(fromLocalInput('2026-13-40T99:99')).toBeNull()
  })
})


describe('formatPlainDate', () => {
  it('formats a date without shifting it', () => {
    expect(formatPlainDate('2026-10-10')).toBe('10 OCT 2026')
    expect(formatPlainDate('2026-01-01')).toBe('01 JAN 2026')
  })
  it('passes junk through unchanged', () => expect(formatPlainDate('soon')).toBe('soon'))
})

describe('formatWhen (MVA-301)', () => {
  const now = new Date('2026-11-23T12:00:00Z')
  it('formats a start as weekday, day, month, 24-hour time with L', () => {
    expect(formatWhen('2026-11-22T15:00:00Z', null, now)).toBe('Sun 22 Nov, 0800L')
  })
  it('formats a same-day range', () => {
    expect(formatWhen('2026-11-22T15:00:00Z', '2026-11-22T23:00:00Z', now)).toBe('Sun 22 Nov, 0800L to 1600L')
  })
  it('adds the year only when it is not the current year', () => {
    expect(formatWhen('2027-01-09T15:00:00Z', null, now)).toBe('Sat 09 Jan 2027, 0800L')
    expect(formatDayShort('2026-12-31T15:00:00Z', now)).toBe('Thu 31 Dec')
  })
  it('names the end day when the event crosses midnight in Phoenix', () => {
    expect(formatWhen('2026-11-22T05:00:00Z', '2026-11-22T09:00:00Z', now)).toBe('Sat 21 Nov, 2200L to Sun 22 Nov, 0200L')
  })
  it('uses Phoenix time, not the viewer zone', () => {
    expect(formatWhen('2026-11-22T06:30:00Z', null, now)).toBe('Sat 21 Nov, 2330L')
  })
})
