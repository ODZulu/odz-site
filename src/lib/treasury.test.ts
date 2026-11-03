import { describe, expect, it } from 'vitest'
import {
  balanceOf,
  filterEntries,
  formatCents,
  NO_FILTER,
  parseAmount,
  reconcile,
  toCsv,
  treasuryMessage,
  type Entry,
  type Fund,
} from './treasury'

let n = 0
const e = (p: Partial<Entry>): Entry => ({
  id: `e${++n}`,
  entry_date: '2026-11-01',
  amount_cents: 100,
  from_kind: 'external',
  from_member: null,
  from_fund: null,
  from_callsign: null,
  to_kind: 'member',
  to_member: 'm1',
  to_fund: null,
  to_callsign: 'Fake-M1',
  category: 'deposit',
  note: '',
  reverses: null,
  entered_by_callsign: 'Fake-O1',
  created_at: '2026-11-01T12:00:00Z',
  ...p,
})
const funds: Fund[] = [{ id: 'f1', name: 'Fake gear' }]

describe('money formatting', () => {
  it('formats integer cents', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(12345)).toBe('$123.45')
    expect(formatCents(123456789)).toBe('$1,234,567.89')
    expect(formatCents(-250)).toBe('-$2.50')
  })
  it('parses an amount without floats', () => {
    expect(parseAmount('12')).toEqual({ ok: true, cents: 1200 })
    expect(parseAmount('12.5')).toEqual({ ok: true, cents: 1250 })
    expect(parseAmount('$1,200.05')).toEqual({ ok: true, cents: 120005 })
    expect(parseAmount('0.29')).toEqual({ ok: true, cents: 29 })
    expect(parseAmount('19.99')).toEqual({ ok: true, cents: 1999 })
  })
  it('rejects zero, negatives, extra decimals, letters and absurd sizes', () => {
    for (const t of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '12.', '.5', '10000000', '1 2']) {
      expect(parseAmount(t)).toEqual({ ok: false })
    }
  })
})

describe('balances derive from entries', () => {
  const ledger = [
    e({ amount_cents: 10000, to_member: 'm1' }),
    e({ amount_cents: 2500, from_kind: 'member', from_member: 'm1', to_kind: 'fund', to_member: null, to_fund: 'f1', category: 'transfer' }),
    e({ amount_cents: 700, from_kind: 'fund', from_fund: 'f1', to_kind: 'external', to_member: null, category: 'withdrawal' }),
  ]
  it('sums in and out per bucket', () => {
    expect(balanceOf(ledger, { kind: 'member', id: 'm1' })).toBe(7500)
    expect(balanceOf(ledger, { kind: 'fund', id: 'f1' })).toBe(1800)
    expect(balanceOf(ledger, { kind: 'member', id: 'nobody' })).toBe(0)
  })
  it('reconciles: buckets equal external in minus external out', () => {
    expect(reconcile(ledger)).toEqual({ net: 9300, buckets: 9300, ok: true })
    expect(reconcile([])).toEqual({ net: 0, buckets: 0, ok: true })
  })
  it('a reversal cancels its original', () => {
    const orig = e({ amount_cents: 400, to_member: 'm2' })
    const rev = e({ amount_cents: 400, from_kind: 'member', from_member: 'm2', to_kind: 'external', to_member: null, category: 'reversal', reverses: orig.id })
    expect(balanceOf([orig, rev], { kind: 'member', id: 'm2' })).toBe(0)
    expect(reconcile([orig, rev]).ok).toBe(true)
  })
})

describe('ledger filters', () => {
  const a = e({ entry_date: '2026-10-01', category: 'deposit' })
  const b = e({ entry_date: '2026-10-15', category: 'event', to_member: 'm2' })
  const c = e({ entry_date: '2026-11-01', category: 'transfer', to_kind: 'fund', to_member: null, to_fund: 'f1' })
  const all = [a, b, c]
  it('filters by inclusive date range', () => {
    expect(filterEntries(all, { ...NO_FILTER, from: '2026-10-15', to: '2026-10-31' })).toEqual([b])
    expect(filterEntries(all, { ...NO_FILTER, from: '2026-10-01', to: '2026-11-01' })).toHaveLength(3)
  })
  it('filters by category and by bucket (either side)', () => {
    expect(filterEntries(all, { ...NO_FILTER, category: 'event' })).toEqual([b])
    expect(filterEntries(all, { ...NO_FILTER, bucket: 'member:m1' })).toEqual([a])
    expect(filterEntries(all, { ...NO_FILTER, bucket: 'fund:f1' })).toEqual([c])
  })
})

describe('CSV export', () => {
  it('writes a header, dollars.cents and resolves names', () => {
    const csv = toCsv([e({ amount_cents: 1205, to_kind: 'fund', to_member: null, to_fund: 'f1', to_callsign: null })], funds)
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('date,amount,from,to,category,note,reverses,entered_by,created_at')
    expect(lines[1]).toBe('2026-11-01,12.05,Outside,Fake gear,deposit,,,Fake-O1,2026-11-01T12:00:00Z')
  })
  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv([e({ note: 'a, "b"\nc' })], funds)
    expect(csv).toContain('"a, ""b""\nc"')
  })
  it('defuses spreadsheet formulas', () => {
    const csv = toCsv([e({ note: '=HYPERLINK("x")' }), e({ note: '+1' }), e({ note: '@x' })], funds)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toContain(",'+1,")
    expect(csv).toContain(",'@x,")
  })
})

describe('messages', () => {
  it('maps database codes without echoing input', () => {
    expect(treasuryMessage('insufficient_funds')).toMatch(/below zero/)
    expect(treasuryMessage('???')).toBe('That did not work. Try again.')
    expect(treasuryMessage(undefined)).toBe('That did not work. Try again.')
  })
})
