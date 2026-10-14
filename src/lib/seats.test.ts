import { describe, expect, it } from 'vitest'
import { fullMessage, isOverCap, seatLine, validateCaps, vacancies, vacancyText, type SeatCounts } from './seats'

const c = (og: number, ogMax: number, cm: number, cmMax: number): SeatCounts => ({
  old_guard_count: og,
  old_guard_max: ogMax,
  command_count: cm,
  command_max: cmMax,
})

describe('seat counters', () => {
  it('formats the line', () => {
    expect(seatLine(c(11, 12, 3, 3))).toBe('Old Guard 11/12, Command 3/3')
  })
  it('lists vacancies and never goes negative', () => {
    expect(vacancies(c(11, 12, 3, 3))).toEqual({ oldGuard: 1, command: 0 })
    expect(vacancies(c(14, 12, 4, 3))).toEqual({ oldGuard: 0, command: 0 })
    expect(vacancyText(c(11, 12, 3, 3))).toBe('Vacant: Old Guard 1, Command 0.')
  })
  it('flags over-cap counts', () => {
    expect(isOverCap(c(12, 12, 3, 3))).toBe(false)
    expect(isOverCap(c(13, 12, 3, 3))).toBe(true)
    expect(isOverCap(c(12, 12, 4, 3))).toBe(true)
    expect(vacancyText(c(13, 12, 3, 3))).toMatch(/Over the cap/)
  })
})

describe('fullMessage', () => {
  it('pulls the database text out of an error', () => {
    expect(fullMessage('Old Guard is full: 12/12')).toBe('Old Guard is full: 12/12')
    expect(fullMessage('error: Command is full: 3/3 (P0001)')).toBe('Command is full: 3/3')
    expect(fullMessage('not allowed')).toBeNull()
    expect(fullMessage(undefined)).toBeNull()
  })
})

describe('validateCaps', () => {
  it('accepts sane caps and explains the rest', () => {
    expect(validateCaps(12, 3)).toBeNull()
    expect(validateCaps(3, 3)).toBeNull()
    expect(validateCaps(2, 3)).toMatch(/cannot be higher/)
    expect(validateCaps(0, 0)).toMatch(/1 to 99/)
    expect(validateCaps(100, 3)).toMatch(/1 to 99/)
    expect(validateCaps(1.5, 1)).toMatch(/whole/)
  })
})
