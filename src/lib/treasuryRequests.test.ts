import { describe, expect, it } from 'vitest'
import { actionsFor, availableCents, checkAmount, needsApproval, reservedCents, stageOf, type TreasuryRequest } from './treasuryRequests'
import { treasuryMessage } from './treasury'

const req = (p: Partial<TreasuryRequest>): TreasuryRequest => ({
  id: 'r1',
  requester: 'm1',
  requester_callsign: 'Fake-M1',
  amount_cents: 3000,
  note: 'Fake',
  status: 'pending',
  needs_approval: false,
  threshold_at_submit: 5000,
  approved_by: null,
  approved_callsign: null,
  decided_callsign: null,
  decision_note: null,
  paid_date: null,
  paid_reference: null,
  created_at: '2026-11-03T12:00:00Z',
  ...p,
})

describe('reservation math', () => {
  it('available is balance minus pending reservations, never negative', () => {
    expect(availableCents(10000, 3000)).toBe(7000)
    expect(availableCents(10000, 10000)).toBe(0)
    expect(availableCents(1000, 3000)).toBe(0)
  })
  it("counts only the member's pending requests", () => {
    const rs = [
      req({ amount_cents: 3000 }),
      req({ id: 'r2', amount_cents: 500 }),
      req({ id: 'r3', status: 'paid' }),
      req({ id: 'r4', requester: 'm2', amount_cents: 9 }),
      req({ id: 'r5', status: 'cancelled' }),
    ]
    expect(reservedCents(rs, 'm1')).toBe(3500)
  })
  it('limits an amount to what is available (no double request, no donating reserved money)', () => {
    expect(checkAmount('25', 2500)).toEqual({ ok: true, cents: 2500 })
    expect(checkAmount('25.01', 2500)).toEqual({ ok: false, message: 'That is more than you have available.' })
    expect(checkAmount('abc', 2500).ok).toBe(false)
    expect(checkAmount('1', 0).ok).toBe(false)
  })
})

describe('approval threshold', () => {
  it('at or below is handled by the Treasurer alone; above needs Command', () => {
    expect(needsApproval(5000, 5000)).toBe(false)
    expect(needsApproval(5001, 5000)).toBe(true)
    expect(needsApproval(1, 0)).toBe(true)
  })
  it('stages: awaiting approval, then with the Treasurer, then closed', () => {
    expect(stageOf(req({ needs_approval: true }))).toBe('awaiting_approval')
    expect(stageOf(req({ needs_approval: true, approved_by: 'c1' }))).toBe('ready_to_pay')
    expect(stageOf(req({ needs_approval: false }))).toBe('ready_to_pay')
    expect(stageOf(req({ status: 'paid' }))).toBe('paid')
    expect(stageOf(req({ status: 'rejected' }))).toBe('rejected')
  })
})

describe('who may act', () => {
  const treasurer = { id: 't1', canManage: true, canApprove: false }
  const command = { id: 'c1', canManage: true, canApprove: true }
  it('the requester can only cancel a pending request', () => {
    expect(actionsFor(req({}), { id: 'm1', canManage: false, canApprove: false })).toEqual({ cancel: true, approve: false, pay: false, reject: false })
    expect(actionsFor(req({ status: 'paid' }), { id: 'm1', canManage: false, canApprove: false }).cancel).toBe(false)
  })
  it('the Treasurer pays small requests but cannot pay a large one before approval', () => {
    expect(actionsFor(req({}), treasurer).pay).toBe(true)
    const big = req({ needs_approval: true })
    expect(actionsFor(big, treasurer)).toEqual({ cancel: false, approve: false, pay: false, reject: true })
    expect(actionsFor({ ...big, approved_by: 'c1' }, treasurer).pay).toBe(true)
  })
  it('Command approves, but never its own request', () => {
    const big = req({ needs_approval: true })
    expect(actionsFor(big, command).approve).toBe(true)
    const own = req({ needs_approval: true, requester: 'c1' })
    expect(actionsFor(own, command)).toEqual({ cancel: true, approve: false, pay: false, reject: false })
  })
  it('a closed request offers nothing', () => {
    expect(actionsFor(req({ status: 'rejected' }), command)).toEqual({ cancel: false, approve: false, pay: false, reject: false })
  })
})

describe('messages', () => {
  it('explains the new codes without echoing input', () => {
    expect(treasuryMessage('own_request')).toMatch(/your own/)
    expect(treasuryMessage('needs_approval')).toMatch(/Command approval/)
    expect(treasuryMessage('not_pending')).toMatch(/no longer pending/)
  })
})
