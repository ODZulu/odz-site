import { expect, test } from '@playwright/test'
import { addDays, dayNumber, moveEventLater, phoenixDay, phoenixInstant } from './helpers/dates'

// No backend needed: pure date arithmetic, so it runs everywhere (MVA-298).
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** What the old spec typed: the UTC date of now + 25 days, taken as a Phoenix date. */
const oldInput = (now: number) => new Date(now + 25 * DAY).toISOString().slice(0, 10)

test.describe('moveEventLater', () => {
  test('shifts by exactly 5 Phoenix days at every hour, across month, year and leap-day boundaries', () => {
    for (const startDay of ['2026-12-25', '2027-02-24', '2028-02-24', '2026-04-27']) {
      const t0 = Date.parse(`${startDay}T00:00:00Z`)
      for (let h = 0; h < 8 * 24; h++) {
        const eventStart = new Date(t0 + h * HOUR + 20 * DAY)
        const move = moveEventLater(eventStart, 5)
        expect(move.shiftDays, `${eventStart.toISOString()}`).toBe(5)
        // What the app will store for the typed value lands exactly 5 Phoenix days later.
        const landed = phoenixDay(phoenixInstant(move.input))
        expect(dayNumber(landed) - dayNumber(phoenixDay(eventStart))).toBe(5)
      }
    }
  })

  test('reproduces MVA-298: the old UTC-date input is 6 days between 00:00 and 07:00 UTC, 5 after', () => {
    const day = '2026-11-21'
    const shiftAt = (utcHour: number) => {
      const now = Date.parse(`${day}T00:00:00Z`) + utcHour * HOUR
      return dayNumber(oldInput(now)) - dayNumber(phoenixDay(new Date(now + 20 * DAY)))
    }
    for (const h of [0, 2, 5, 6]) expect(shiftAt(h), `old input at ${h}:xx UTC`).toBe(6)
    for (const h of [7, 8, 14, 23]) expect(shiftAt(h), `old input at ${h}:xx UTC`).toBe(5)
  })
})

test('addDays and dayNumber agree across boundaries', () => {
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
  expect(dayNumber('2027-01-01') - dayNumber('2026-12-31')).toBe(1)
})
