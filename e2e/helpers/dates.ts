/**
 * Phoenix calendar-day arithmetic for e2e specs (MVA-298). The app works in America/Phoenix (UTC-7,
 * no daylight saving), while a test runs on a UTC clock. Deriving a "date to type" from the UTC date
 * is off by one day between 00:00 and 07:00 UTC, so specs derive dates from the instants they seed.
 */
const phoenixDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' })

const DAY_MS = 86_400_000

/** The Phoenix calendar day (`YYYY-MM-DD`) an instant falls on. */
export const phoenixDay = (instant: Date | string): string => phoenixDate.format(new Date(instant))

/** Whole days since 1970-01-01 for a `YYYY-MM-DD` day. Pure calendar arithmetic, no clock or timezone. */
export const dayNumber = (day: string): number => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS

/** `YYYY-MM-DD` plus `n` days (month, year and leap-day boundaries included). */
export const addDays = (day: string, n: number): string => new Date((dayNumber(day) + n) * DAY_MS).toISOString().slice(0, 10)

/** The value for a `datetime-local` "Phoenix time" field: that day at `time` (24-hour `HH:MM`). */
export const phoenixInput = (day: string, time = '10:00'): string => `${day}T${time}`

/** The instant a `datetime-local` Phoenix value means (UTC-7, no daylight saving). */
export const phoenixInstant = (input: string): Date => new Date(`${input}:00-07:00`)

/**
 * Moving an event `days` Phoenix days later: the value to type, and the shift (in whole days) that
 * typing it makes to the event's Phoenix date, computed from the dates themselves.
 */
export function moveEventLater(startsAt: Date | string, days: number): { input: string; shiftDays: number } {
  const from = phoenixDay(startsAt)
  const to = addDays(from, days)
  return { input: phoenixInput(to), shiftDays: dayNumber(to) - dayNumber(from) }
}
