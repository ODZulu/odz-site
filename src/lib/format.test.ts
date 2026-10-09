import { describe, expect, it } from 'vitest'
import { formatStamp } from './format'

describe('formatStamp', () => {
  it('formats the team style stamp with a 24-hour local time', () => {
    expect(formatStamp(new Date(2026, 8, 30, 6, 30))).toBe('30 SEP 2026 · 0630L')
    expect(formatStamp(new Date(2026, 0, 5, 18, 5))).toBe('05 JAN 2026 · 1805L')
  })
})
