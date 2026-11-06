import { describe, expect, it } from 'vitest'
import {
  describeRule,
  emptySeriesForm,
  expandOccurrences,
  localToUtc,
  nthWeekday,
  seriesMessage,
  toCreateArgs,
  validateSeries,
  type SeriesForm,
} from './recurrence'

const weekly = (first: string, extra: object = {}) => ({ rule: 'weekly' as const, first_date: first, interval_weeks: 1, nth: null, until_date: null, max_count: null, ...extra })
const monthly = (first: string, nth: number, extra: object = {}) => ({ rule: 'monthly_weekday' as const, first_date: first, interval_weeks: 1, nth, until_date: null, max_count: null, ...extra })

describe('nthWeekday', () => {
  it('finds the 2nd Tuesday', () => expect(nthWeekday(2026, 11, 2, 2)).toBe('2026-11-10'))
  it('finds the 1st Sunday', () => expect(nthWeekday(2026, 11, 0, 1)).toBe('2026-11-01'))
  it('finds the last Friday, including a month that ends on one', () => {
    expect(nthWeekday(2026, 11, 5, 5)).toBe('2026-11-27')
    expect(nthWeekday(2026, 7, 5, 5)).toBe('2026-07-31')
  })
  it('crosses year ends and leap days', () => {
    expect(nthWeekday(2027, 1, 1, 1)).toBe('2027-01-04')
    expect(nthWeekday(2028, 2, 2, 5)).toBe('2028-02-29')
  })
})

describe('expandOccurrences', () => {
  it('weekly every week inside the 90-day window, never before today', () => {
    const d = expandOccurrences(weekly('2026-11-03'), '2026-11-06')
    expect(d[0]).toBe('2026-11-10')
    expect(d.every((x) => x >= '2026-11-06' && x <= '2027-02-04')).toBe(true)
    expect(d).toHaveLength(13)
  })
  it('every N weeks', () => {
    expect(expandOccurrences(weekly('2026-11-03', { interval_weeks: 2 }), '2026-11-06').slice(0, 3)).toEqual(['2026-11-17', '2026-12-01', '2026-12-15'])
  })
  it('monthly by weekday: 2nd Tuesday', () => {
    expect(expandOccurrences(monthly('2026-11-10', 2), '2026-11-06')).toEqual(['2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09'].filter((x) => x <= '2027-02-04'))
  })
  it('monthly skips a first month whose Nth weekday is before the first date', () => {
    // First date 2026-11-20 with "1st Friday": November's 1st Friday (the 6th) is before it, so December's is first.
    expect(expandOccurrences(monthly('2026-11-20', 1), '2026-11-06')[0]).toBe('2026-12-04')
  })
  it('stops at the end date and at the count', () => {
    expect(expandOccurrences(weekly('2026-11-03', { until_date: '2026-11-24' }), '2026-11-06')).toEqual(['2026-11-10', '2026-11-17', '2026-11-24'])
    // The count includes occurrences before today: 3 counted from 11-03 are 11-03, 11-10, 11-17.
    expect(expandOccurrences(weekly('2026-11-03', { max_count: 3 }), '2026-11-06')).toEqual(['2026-11-10', '2026-11-17'])
  })
  it('is idempotent: the same inputs give the same dates', () => {
    const a = expandOccurrences(monthly('2026-11-10', 2), '2026-11-06')
    expect(expandOccurrences(monthly('2026-11-10', 2), '2026-11-06')).toEqual(a)
  })
})

describe('localToUtc keeps the local time across daylight saving', () => {
  it('Phoenix never changes', () => {
    expect(localToUtc('2026-03-07', '19:00', 'America/Phoenix')).toBe('2026-03-08T02:00:00.000Z')
    expect(localToUtc('2026-03-10', '19:00', 'America/Phoenix')).toBe('2026-03-11T02:00:00.000Z')
  })
  it('New York is 19:00 before and after the spring change (UTC shifts by an hour)', () => {
    expect(localToUtc('2026-03-07', '19:00', 'America/New_York')).toBe('2026-03-08T00:00:00.000Z')
    expect(localToUtc('2026-03-09', '19:00', 'America/New_York')).toBe('2026-03-09T23:00:00.000Z')
  })
  it('New York is 19:00 before and after the autumn change', () => {
    expect(localToUtc('2026-10-31', '19:00', 'America/New_York')).toBe('2026-10-31T23:00:00.000Z')
    expect(localToUtc('2026-11-02', '19:00', 'America/New_York')).toBe('2026-11-03T00:00:00.000Z')
  })
})

describe('describeRule', () => {
  it('says the rule in words', () => {
    expect(describeRule(weekly('2026-11-03'))).toBe('Every week on Tuesday')
    expect(describeRule(weekly('2026-11-03', { interval_weeks: 2 }))).toBe('Every 2 weeks on Tuesday')
    expect(describeRule(monthly('2026-11-10', 2))).toBe('2nd Tuesday of every month')
    expect(describeRule(monthly('2026-11-27', 5))).toBe('Last Friday of every month')
  })
})

describe('validateSeries and toCreateArgs', () => {
  const ok: SeriesForm = { ...emptySeriesForm, title: 'Fake touch-base', first_date: '2026-11-10' }
  it('accepts a complete form', () => expect(validateSeries(ok)).toEqual({}))
  it('needs a title, a date and sane numbers', () => {
    expect(validateSeries({ ...ok, title: ' ' }).title).toBeDefined()
    expect(validateSeries({ ...ok, first_date: '' }).first_date).toBeDefined()
    expect(validateSeries({ ...ok, duration_minutes: '5' }).duration_minutes).toBeDefined()
    expect(validateSeries({ ...ok, rule: 'weekly', interval_weeks: '0' }).interval_weeks).toBeDefined()
    expect(validateSeries({ ...ok, nth: '6' }).nth).toBeDefined()
    expect(validateSeries({ ...ok, until_date: '2026-01-01' }).until_date).toBeDefined()
    expect(validateSeries({ ...ok, max_count: '0' }).max_count).toBeDefined()
  })
  it('builds the RPC arguments for each rule', () => {
    expect(toCreateArgs(ok, 'America/Phoenix')).toMatchObject({ p_rule: 'monthly_weekday', p_nth: 2, p_interval_weeks: null, p_audience: 'command', p_timezone: 'America/Phoenix' })
    expect(toCreateArgs({ ...ok, rule: 'weekly', interval_weeks: '2' }, 'America/Phoenix')).toMatchObject({ p_rule: 'weekly', p_interval_weeks: 2, p_nth: null })
  })
  it('maps database codes without echoing text', () => {
    expect(seriesMessage('invalid_timezone')).toMatch(/timezone/)
    expect(seriesMessage('raw sql')).toMatch(/did not work/)
  })
})
