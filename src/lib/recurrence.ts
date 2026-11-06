/**
 * Recurring event series (MVA-228). The database generates the instances (event_series_generate);
 * this mirrors its rules so the create form can preview the next dates and the list can say a rule
 * in plain words. Local times stay constant across daylight-saving changes: an instance's start is
 * built from a calendar date plus a local time in the series' IANA timezone, never by adding 24 h.
 */

export type Audience = 'members' | 'old_guard' | 'command'
export type RuleKind = 'weekly' | 'monthly_weekday'

export const AUDIENCE_LABEL: Record<Audience, string> = {
  members: 'All members',
  old_guard: 'Old Guard and Command',
  command: 'Command only',
}

export const AUDIENCES: readonly Audience[] = ['members', 'old_guard', 'command']

export type Series = {
  id: string
  title: string
  event_type: string
  audience: Audience
  first_date: string
  start_time: string
  duration_minutes: number
  timezone: string
  rule: RuleKind
  interval_weeks: number
  nth: number | null
  until_date: string | null
  max_count: number | null
  location_name: string | null
  description: string | null
  status: 'active' | 'cancelled'
  next_starts_at: string | null
}

export const WINDOW_DAYS = 90
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDINAL: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: 'last' }

const parseDate = (d: string): Date => new Date(`${d}T00:00:00Z`)
const fmtDate = (d: Date): string => d.toISOString().slice(0, 10)
export const weekdayOf = (date: string): number => parseDate(date).getUTCDay()
export const addDays = (date: string, n: number): string => fmtDate(new Date(parseDate(date).getTime() + n * 86_400_000))

/** The date of the Nth weekday (0 = Sunday) of a month; nth 5 means the last one. Mirrors nth_weekday(). */
export function nthWeekday(year: number, month: number, dow: number, nth: number): string {
  if (nth === 5) {
    const last = new Date(Date.UTC(year, month, 0))
    return fmtDate(new Date(last.getTime() - ((last.getUTCDay() - dow + 7) % 7) * 86_400_000))
  }
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = ((dow - first.getUTCDay() + 7) % 7) + (nth - 1) * 7
  return fmtDate(new Date(first.getTime() + offset * 86_400_000))
}

type RuleInput = Pick<Series, 'rule' | 'first_date' | 'interval_weeks' | 'nth' | 'until_date' | 'max_count'>

/** Occurrence dates from `today` up to WINDOW_DAYS ahead, honouring the end date and count. Mirrors the SQL. */
export function expandOccurrences(r: RuleInput, today: string, windowDays = WINDOW_DAYS): string[] {
  const horizon = addDays(today, windowDays)
  const dow = weekdayOf(r.first_date)
  const year = Number(r.first_date.slice(0, 4))
  const month = Number(r.first_date.slice(5, 7))
  const out: string[] = []
  let count = 0
  for (let k = 0; k < 5000; ) {
    let date: string
    if (r.rule === 'weekly') {
      date = addDays(r.first_date, k * 7 * r.interval_weeks)
    } else {
      date = nthWeekday(year + Math.floor((month - 1 + k) / 12), ((month - 1 + k) % 12) + 1, dow, r.nth ?? 1)
      if (date < r.first_date) {
        k += 1
        continue
      }
    }
    k += 1
    if (date > horizon) break
    if (r.until_date && date > r.until_date) break
    count += 1
    if (r.max_count !== null && count > r.max_count) break
    if (date >= today) out.push(date)
  }
  return out
}

/** Offset of a timezone from UTC at an instant, in minutes. */
function offsetMinutes(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - instant) / 60_000)
}

/** A calendar date plus a local time ("19:00") in an IANA timezone, as a UTC ISO string. Mirrors `(date + time) at time zone tz`. */
export function localToUtc(date: string, time: string, tz: string): string {
  const [h, m] = time.split(':').map(Number)
  const naive = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m)
  // Two passes settle the offset even when the guess lands on the other side of a change.
  let guess = naive - offsetMinutes(naive, tz) * 60_000
  guess = naive - offsetMinutes(guess, tz) * 60_000
  return new Date(guess).toISOString()
}

/** "Every week on Tuesday", "Every 2 weeks on Tuesday", "2nd Tuesday of every month", "Last Friday of every month". */
export function describeRule(r: Pick<Series, 'rule' | 'first_date' | 'interval_weeks' | 'nth'>): string {
  const day = WEEKDAYS[weekdayOf(r.first_date)]
  if (r.rule === 'monthly_weekday') {
    const nth = ORDINAL[r.nth ?? 1]
    return `${nth[0].toUpperCase()}${nth.slice(1)} ${day} of every month`
  }
  return r.interval_weeks === 1 ? `Every week on ${day}` : `Every ${r.interval_weeks} weeks on ${day}`
}

export type SeriesForm = {
  title: string
  event_type: string
  audience: Audience
  first_date: string
  start_time: string
  duration_minutes: string
  rule: RuleKind
  interval_weeks: string
  nth: string
  until_date: string
  max_count: string
  location_name: string
  description: string
}

export const emptySeriesForm: SeriesForm = {
  title: '',
  event_type: 'Meeting',
  audience: 'command',
  first_date: '',
  start_time: '19:00',
  duration_minutes: '60',
  rule: 'monthly_weekday',
  interval_weeks: '1',
  nth: '2',
  until_date: '',
  max_count: '',
  location_name: '',
  description: '',
}

export type SeriesErrors = Partial<Record<keyof SeriesForm, string>>

export function validateSeries(f: SeriesForm): SeriesErrors {
  const e: SeriesErrors = {}
  if (f.title.trim() === '') e.title = 'Title is required.'
  else if (f.title.trim().length > 120) e.title = 'Title is too long (120 characters).'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.first_date) || Number.isNaN(parseDate(f.first_date).getTime())) e.first_date = 'Enter the first date.'
  if (!/^\d{2}:\d{2}$/.test(f.start_time)) e.start_time = 'Enter a start time.'
  const dur = Number(f.duration_minutes)
  if (!Number.isInteger(dur) || dur < 15 || dur > 1440) e.duration_minutes = '15 to 1440 minutes.'
  if (f.rule === 'weekly') {
    const n = Number(f.interval_weeks)
    if (!Number.isInteger(n) || n < 1 || n > 52) e.interval_weeks = 'Every 1 to 52 weeks.'
  } else {
    const n = Number(f.nth)
    if (!Number.isInteger(n) || n < 1 || n > 5) e.nth = 'Choose which weekday of the month.'
  }
  if (f.until_date && !e.first_date && f.until_date < f.first_date) e.until_date = 'The end date cannot be before the first date.'
  if (f.max_count.trim() !== '') {
    const c = Number(f.max_count)
    if (!Number.isInteger(c) || c < 1 || c > 500) e.max_count = 'Whole number from 1 to 500, or leave empty.'
  }
  if (f.location_name.length > 120) e.location_name = 'Too long (120 characters).'
  if (f.description.length > 5000) e.description = 'Too long (5000 characters).'
  return e
}

/** The arguments of the event_series_create() RPC. Call only after validateSeries() is clean. */
export function toCreateArgs(f: SeriesForm, timezone: string) {
  return {
    p_title: f.title.trim(),
    p_event_type: f.event_type,
    p_audience: f.audience,
    p_first_date: f.first_date,
    p_start_time: f.start_time,
    p_duration_minutes: Number(f.duration_minutes),
    p_timezone: timezone,
    p_rule: f.rule,
    p_interval_weeks: f.rule === 'weekly' ? Number(f.interval_weeks) : null,
    p_nth: f.rule === 'monthly_weekday' ? Number(f.nth) : null,
    p_until: f.until_date || null,
    p_max_count: f.max_count.trim() === '' ? null : Number(f.max_count),
    p_location_name: f.location_name.trim() || null,
    p_description: f.description.trim() || null,
  }
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  invalid_title: 'Give the series a title (1 to 120 characters).',
  invalid_audience: 'Choose who the meetings are for.',
  invalid_date: 'Enter the first date and a start time.',
  invalid_duration: 'Duration must be 15 to 1440 minutes.',
  invalid_timezone: 'That timezone is not recognised.',
  invalid_rule: 'Choose a repeat rule.',
  invalid_interval: 'Repeat every 1 to 52 weeks.',
  invalid_nth: 'Choose which weekday of the month.',
  invalid_end: 'Check the end date and the number of meetings.',
  series_cancelled: 'That series is already cancelled.',
  'not found': 'That series is not available.',
}

export function seriesMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Check the form and try again.'
}
