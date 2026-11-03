import { describe, expect, it } from 'vitest'
import { currentMotion, escalates, liveMessage, liveResult, outstanding, parseQuorum, validateRecord, votingState } from './liveVote'
import { eligibleVoters, type Candidate } from './motions'

const c = (eligible: number, yes: number, no: number, abstain = 0) => ({ eligible, yes, no, abstain })

describe('result calculation (D27: strict majority of all eligible voters)', () => {
  it('passes on a strict Yes majority and fails on a strict No majority', () => {
    expect(liveResult(c(5, 3, 1), null)).toBe('passed')
    expect(liveResult(c(5, 1, 3), null)).toBe('failed')
    expect(liveResult(c(4, 3, 0), null)).toBe('passed')
  })
  it('counts the majority against everyone eligible, not the votes cast', () => {
    expect(liveResult(c(5, 2, 0, 1), null)).toBe('tie')
    expect(liveResult(c(4, 2, 1), null)).toBe('tie')
    expect(liveResult(c(6, 3, 2), null)).toBe('tie')
  })
  it('is a tie when nothing reaches a majority', () => {
    expect(liveResult(c(5, 1, 1, 1), null)).toBe('tie')
    expect(liveResult(c(5, 0, 0, 0), null)).toBe('tie')
  })
  it('escalates a tie, and fewer than 3 eligible voters, but not a decided vote', () => {
    expect(escalates(liveResult(c(5, 2, 2, 1), null))).toBe(true)
    expect(liveResult(c(2, 2, 0), null)).toBe('tie')
    expect(escalates(liveResult(c(2, 2, 0), null))).toBe(true)
    expect(escalates('passed')).toBe(false)
    expect(escalates('failed')).toBe(false)
    expect(escalates('no_quorum')).toBe(false)
  })
})

describe('quorum is a setting with no default', () => {
  it('has no quorum rule when none is set', () => {
    expect(liveResult(c(5, 3, 0), null)).toBe('passed')
    expect(liveResult(c(5, 0, 0), null)).toBe('tie')
  })
  it('counts abstentions as votes cast', () => {
    expect(liveResult(c(5, 3, 0, 0), 4)).toBe('no_quorum')
    expect(liveResult(c(5, 3, 0, 1), 4)).toBe('passed')
    expect(liveResult(c(5, 2, 1, 1), 4)).toBe('tie')
  })
  it('takes precedence over a majority', () => {
    expect(liveResult(c(3, 2, 0), 3)).toBe('no_quorum')
  })
})

describe('voting state', () => {
  it('is not opened without a motion or after a withdrawal', () => {
    expect(votingState(null)).toBe('not_opened')
    expect(votingState({ state: 'closed', status: 'withdrawn', live_closed_at: null })).toBe('not_opened')
  })
  it('is open until the chair closes it', () => {
    expect(votingState({ state: 'open', status: 'open', live_closed_at: null })).toBe('open')
  })
  it('is closed once the chair closed it, even when a tie waits for an Admin', () => {
    expect(votingState({ state: 'closed', status: 'decided', live_closed_at: '2026-11-03T20:00:00Z' })).toBe('closed')
    expect(votingState({ state: 'open', status: 'escalated_final', live_closed_at: '2026-11-03T20:00:00Z' })).toBe('closed')
  })
  it('uses the newest motion that was not withdrawn', () => {
    const ms = [
      { id: 'a', status: 'withdrawn', created_at: '2026-11-03T10:00:00Z' },
      { id: 'b', status: 'open', created_at: '2026-11-03T11:00:00Z' },
    ]
    expect(currentMotion(ms)?.id).toBe('b')
    expect(currentMotion([ms[0]])).toBeNull()
  })
})

describe('eligibility snapshot (same rule as a motion round)', () => {
  const members: Candidate[] = [
    { id: 'c1', seatGroup: 'command', status: 'approved' },
    { id: 'o1', seatGroup: 'old_guard', status: 'approved' },
    { id: 'o2', seatGroup: 'old_guard', status: 'retired' },
    { id: 'o3', seatGroup: 'old_guard', status: 'removed' },
    { id: 'm1', seatGroup: null, status: 'approved' },
  ]
  it('is Old Guard and Command, minus parties and recused, and never retired or removed members', () => {
    expect(eligibleVoters('old_guard', members, [], [])).toEqual(['c1', 'o1'])
    expect(eligibleVoters('old_guard', members, ['o1'], [])).toEqual(['c1'])
  })
  it('stays what it was when opened: the list is data, not recomputed', () => {
    const snapshot = eligibleVoters('old_guard', members, [], [])
    const later = members.map((m) => (m.id === 'o1' ? { ...m, seatGroup: null } : m))
    expect(eligibleVoters('old_guard', later, [], [])).toEqual(['c1'])
    expect(snapshot).toEqual(['c1', 'o1'])
  })
})

describe('forms and messages', () => {
  it('counts what is outstanding without going negative', () => {
    expect(outstanding(5, 2)).toBe(3)
    expect(outstanding(5, 7)).toBe(0)
  })
  it('validates the chair-recorded vote', () => {
    expect(validateRecord('', 'Yes', 'present')).toMatch(/voter/)
    expect(validateRecord('v', 'Maybe', 'present')).toMatch(/Yes, No or Abstain/)
    expect(validateRecord('v', 'Yes', 'x')).toMatch(/note/)
    expect(validateRecord('v', 'Yes', 'present, no phone')).toBeNull()
  })
  it('parses the quorum box', () => {
    expect(parseQuorum('')).toEqual({ ok: true, value: null })
    expect(parseQuorum(' 4 ')).toEqual({ ok: true, value: 4 })
    expect(parseQuorum('0')).toEqual({ ok: false })
    expect(parseQuorum('101')).toEqual({ ok: false })
    expect(parseQuorum('2.5')).toEqual({ ok: false })
    expect(parseQuorum('-1')).toEqual({ ok: false })
  })
  it('maps database codes without echoing input', () => {
    expect(liveMessage('wording_frozen')).toMatch(/frozen/)
    expect(liveMessage('whatever')).toBe('That did not work. Try again.')
  })
})
