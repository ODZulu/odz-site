import { describe, expect, it } from 'vitest'
import {
  costLabel,
  countsLine,
  emptyOpportunityForm,
  filterOpportunities,
  opportunityMessage,
  parseCost,
  toSaveArgs,
  validateOpportunity,
  type Opportunity,
  type OpportunityForm,
} from './opportunities'

const ok: OpportunityForm = { ...emptyOpportunityForm, title: 'Fake Game', starts_on: '2026-12-05', ends_on: '2026-12-06', cost: '45.5' }

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: 'x',
  title: 'T',
  host: null,
  source_url: null,
  starts_on: '2026-12-01',
  ends_on: null,
  location_text: null,
  latitude: null,
  longitude: null,
  est_cost_cents: null,
  notes: null,
  status: 'open',
  created_by: null,
  creator_callsign: null,
  event_id: null,
  drop_reason: null,
  in_count: 0,
  maybe_count: 0,
  out_count: 0,
  my_response: null,
  ...over,
})

describe('validateOpportunity', () => {
  it('accepts a complete form and a title-and-start-only form', () => {
    expect(validateOpportunity(ok)).toEqual({})
    expect(validateOpportunity({ ...emptyOpportunityForm, title: 'A', starts_on: '2026-12-05' })).toEqual({})
  })
  it('requires a title and a real start date', () => {
    const e = validateOpportunity(emptyOpportunityForm)
    expect(e.title).toBeDefined()
    expect(e.starts_on).toBeDefined()
    expect(validateOpportunity({ ...ok, starts_on: '2026-02-30' }).starts_on).toBeDefined()
  })
  it('rejects an end before the start, and a bad end date', () => {
    expect(validateOpportunity({ ...ok, ends_on: '2026-12-04' }).ends_on).toBeDefined()
    expect(validateOpportunity({ ...ok, ends_on: 'soon' }).ends_on).toBeDefined()
    expect(validateOpportunity({ ...ok, ends_on: '2026-12-05' }).ends_on).toBeUndefined()
  })
  it('only allows web addresses as the source', () => {
    expect(validateOpportunity({ ...ok, source_url: 'javascript:alert(1)' }).source_url).toBeDefined()
    expect(validateOpportunity({ ...ok, source_url: 'https://example.invalid/e' }).source_url).toBeUndefined()
  })
  it('checks lengths', () => {
    expect(validateOpportunity({ ...ok, title: 'x'.repeat(121) }).title).toBeDefined()
    expect(validateOpportunity({ ...ok, notes: 'x'.repeat(2001) }).notes).toBeDefined()
  })
})

describe('parseCost', () => {
  it('turns dollars into cents without floats', () => {
    expect(parseCost('')).toEqual({ ok: true, cents: null })
    expect(parseCost('0')).toEqual({ ok: true, cents: 0 })
    expect(parseCost('45')).toEqual({ ok: true, cents: 4500 })
    expect(parseCost('45.5')).toEqual({ ok: true, cents: 4550 })
    expect(parseCost('$1,200.05')).toEqual({ ok: true, cents: 120005 })
  })
  it('rejects junk', () => {
    for (const t of ['abc', '-5', '1.234', '12345678', '1e3']) expect(parseCost(t).ok).toBe(false)
  })
})

describe('toSaveArgs', () => {
  it('trims, nulls the empties and converts the cost', () => {
    const a = toSaveArgs(null, { ...ok, title: '  Fake Game ', host: ' ', cost: '45.5' })
    expect(a).toMatchObject({ p_id: null, p_title: 'Fake Game', p_host: null, p_est_cost_cents: 4550, p_ends_on: '2026-12-06' })
  })
})

describe('filterOpportunities', () => {
  const rows = [
    opp({ id: 'b', starts_on: '2026-12-10', my_response: 'In' }),
    opp({ id: 'a', starts_on: '2026-12-01', my_response: 'Maybe' }),
    opp({ id: 'c', starts_on: '2026-11-20', status: 'dropped', my_response: 'In' }),
  ]
  it('sorts by start date and filters by status', () => {
    expect(filterOpportunities(rows, 'open', false).map((o) => o.id)).toEqual(['a', 'b'])
    expect(filterOpportunities(rows, 'all', false).map((o) => o.id)).toEqual(['c', 'a', 'b'])
  })
  it('filters to the ones I am In on', () => {
    expect(filterOpportunities(rows, 'all', true).map((o) => o.id)).toEqual(['c', 'b'])
    expect(filterOpportunities(rows, 'open', true).map((o) => o.id)).toEqual(['b'])
  })
})

describe('labels', () => {
  it('formats cost and counts', () => {
    expect(costLabel(null)).toBe('Not given')
    expect(costLabel(0)).toBe('Free')
    expect(costLabel(4550)).toBe('$45.50 per person')
    expect(countsLine({ in_count: 3, maybe_count: 1, out_count: 0 })).toBe('3 In, 1 Maybe, 0 Out')
  })
  it('maps database codes and never echoes unknown text', () => {
    expect(opportunityMessage('not_open')).toMatch(/no longer open/)
    expect(opportunityMessage('some raw sql error')).toMatch(/did not work/)
    expect(opportunityMessage(undefined)).toMatch(/did not work/)
  })
})
