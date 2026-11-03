import { describe, expect, it } from 'vitest'
import {
  afterTie,
  atDeadline,
  eligibleVoters,
  filterMotions,
  isStrictMajority,
  motionMessage,
  outlook,
  parseOptions,
  statusLabel,
  tally,
  timeLeft,
  type Candidate,
} from './motions'

const opts = ['Approve', 'Reject']
const v = (...o: string[]) => o.map((option) => ({ option }))

describe('majority', () => {
  it('is strict and counts all eligible voters, not the votes cast', () => {
    expect(isStrictMajority(2, 3)).toBe(true)
    expect(isStrictMajority(2, 4)).toBe(false)
    expect(isStrictMajority(3, 5)).toBe(true)
    expect(isStrictMajority(3, 6)).toBe(false)
  })
  it('tallies per option and ignores unknown ones', () => {
    expect(tally(opts, v('Approve', 'Approve', 'Reject', 'Maybe'))).toEqual({ Approve: 2, Reject: 1 })
  })
})

describe('outlook', () => {
  it('decides early once a strict majority exists', () => {
    expect(outlook(opts, v('Approve', 'Approve'), 3)).toEqual({ kind: 'decided', winner: 'Approve' })
  })
  it('stays pending while a majority is still reachable', () => {
    expect(outlook(opts, v('Approve'), 3)).toEqual({ kind: 'pending' })
    expect(outlook(opts, [], 5)).toEqual({ kind: 'pending' })
    expect(outlook(opts, v('Approve', 'Reject'), 5)).toEqual({ kind: 'pending' })
  })
  it('is a tie as soon as no option can reach a majority', () => {
    expect(outlook(opts, v('Approve', 'Reject', 'Approve', 'Reject'), 4)).toEqual({ kind: 'tie', reason: 'no_majority_possible' })
    expect(outlook(opts, v('Approve', 'Reject'), 4)).toEqual({ kind: 'pending' })
    expect(outlook(['A', 'B', 'C'], v('A', 'B', 'C'), 3)).toEqual({ kind: 'tie', reason: 'no_majority_possible' })
  })
  it('escalates with fewer than 3 eligible voters, whatever was voted', () => {
    expect(outlook(opts, v('Approve', 'Approve'), 2)).toEqual({ kind: 'tie', reason: 'too_few_voters' })
    expect(outlook(opts, [], 0)).toEqual({ kind: 'tie', reason: 'too_few_voters' })
  })
  it('treats no majority at the deadline as a tie', () => {
    expect(atDeadline(opts, v('Approve'), 3)).toEqual({ kind: 'tie', reason: 'no_majority_possible' })
    expect(atDeadline(opts, v('Approve', 'Approve'), 3)).toEqual({ kind: 'decided', winner: 'Approve' })
  })
})

describe('escalation ladder', () => {
  it('goes Command, then Old Guard, then an Admin', () => {
    expect(afterTie('command')).toBe('old_guard')
    expect(afterTie('old_guard')).toBe('admin')
  })
})

describe('eligible voters (the snapshot rule)', () => {
  const members: Candidate[] = [
    { id: 'c1', seatGroup: 'command', status: 'approved' },
    { id: 'c2', seatGroup: 'command', status: 'approved' },
    { id: 'o1', seatGroup: 'old_guard', status: 'approved' },
    { id: 'o2', seatGroup: 'old_guard', status: 'retired' },
    { id: 'o3', seatGroup: 'old_guard', status: 'removed' },
    { id: 'm1', seatGroup: null, status: 'approved' },
  ]
  it('Command body is Command only', () => {
    expect(eligibleVoters('command', members, [], [])).toEqual(['c1', 'c2'])
  })
  it('Old Guard body includes Command, and skips retired and removed members', () => {
    expect(eligibleVoters('old_guard', members, [], [])).toEqual(['c1', 'c2', 'o1'])
  })
  it('drops parties and recused members', () => {
    expect(eligibleVoters('old_guard', members, ['c1'], ['o1'])).toEqual(['c2'])
  })
})

describe('labels and helpers', () => {
  it('names the status', () => {
    expect(statusLabel({ state: 'draft', status: 'open', round: 1 })).toBe('DRAFT')
    expect(statusLabel({ state: 'open', status: 'open', round: 1 })).toBe('OPEN')
    expect(statusLabel({ state: 'open', status: 'escalated', round: 2 })).toMatch(/OLD GUARD/)
    expect(statusLabel({ state: 'open', status: 'escalated_final', round: 2 })).toMatch(/ADMIN/)
    expect(statusLabel({ state: 'closed', status: 'decided', round: 1 })).toBe('DECIDED')
    expect(statusLabel({ state: 'closed', status: 'withdrawn', round: 1 })).toBe('WITHDRAWN')
  })
  it('filters the list', () => {
    const rows = [
      { state: 'open' as const, opened_by: 'a' },
      { state: 'draft' as const, opened_by: 'b' },
      { state: 'closed' as const, opened_by: 'a' },
    ]
    expect(filterMotions(rows, 'open', 'a')).toHaveLength(2)
    expect(filterMotions(rows, 'closed', 'a')).toHaveLength(1)
    expect(filterMotions(rows, 'mine', 'a')).toHaveLength(2)
    expect(filterMotions(rows, 'all', 'a')).toHaveLength(3)
  })
  it('words the time left', () => {
    const now = Date.parse('2026-11-03T12:00:00Z')
    expect(timeLeft(null, now)).toBeNull()
    expect(timeLeft('2026-11-03T11:00:00Z', now)).toBe('deadline passed')
    expect(timeLeft('2026-11-03T12:30:00Z', now)).toBe('30 min left')
    expect(timeLeft('2026-11-03T20:00:00Z', now)).toBe('8 h left')
    expect(timeLeft('2026-11-06T12:00:00Z', now)).toBe('3 days left')
  })
  it('parses the options box', () => {
    expect(parseOptions('Upheld\nCorrected\n Voided ')).toEqual(['Upheld', 'Corrected', 'Voided'])
    expect(parseOptions('Only')).toBeNull()
    expect(parseOptions('A\nA')).toBeNull()
    expect(parseOptions('1\n2\n3\n4\n5\n6\n7')).toBeNull()
    expect(parseOptions(`A\n${'x'.repeat(41)}`)).toBeNull()
  })
  it('maps error codes and never echoes input', () => {
    expect(motionMessage('not_eligible')).toMatch(/eligible/)
    expect(motionMessage('not allowed')).toMatch(/not allowed/)
    expect(motionMessage('something else')).toBe('That did not work. Try again.')
    expect(motionMessage(undefined)).toBe('That did not work. Try again.')
  })
})
