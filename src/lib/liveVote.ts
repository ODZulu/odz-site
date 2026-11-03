/**
 * Live meeting votes (MVA-246). The database decides (close_live_vote); these helpers mirror the
 * rule so the screens can explain it, and are tested against the same cases as the SQL.
 */

export const LIVE_OPTIONS = ['Yes', 'No', 'Abstain'] as const
export type LiveOption = (typeof LIVE_OPTIONS)[number]
export type LiveResult = 'passed' | 'failed' | 'tie' | 'no_quorum'
export type VotingState = 'not_opened' | 'open' | 'closed'

/** Fewer eligible voters than this and the vote cannot be decided here; it goes to the Admin. */
export const MIN_ELIGIBLE = 3

export type Counts = { eligible: number; yes: number; no: number; abstain: number }

/**
 * The D27 rule at close: a strict majority of ALL eligible voters. Yes majority passes, No majority
 * fails, anything else is a tie. A quorum (when one is set; there is no default) is the least
 * number of votes cast, abstentions included; fewer is no quorum. A tie, or fewer than 3 eligible
 * voters, escalates (the body is already the Old Guard, so an Admin records the outcome).
 */
export function liveResult(c: Counts, quorum: number | null): LiveResult {
  const cast = c.yes + c.no + c.abstain
  if (quorum !== null && cast < quorum) return 'no_quorum'
  if (c.eligible < MIN_ELIGIBLE) return 'tie'
  if (c.yes * 2 > c.eligible) return 'passed'
  if (c.no * 2 > c.eligible) return 'failed'
  return 'tie'
}

/** Whether a result goes on to the escalation ladder (an Admin records the outcome). */
export const escalates = (r: LiveResult): boolean => r === 'tie'

export const RESULT_LABEL: Record<LiveResult, string> = {
  passed: 'Passed',
  failed: 'Failed',
  tie: 'Tie: an Admin records the outcome',
  no_quorum: 'No quorum: no result',
}

export type LiveMotionState = { state: 'draft' | 'open' | 'closed'; status: string; live_closed_at: string | null }

/** not opened (no motion, or only a withdrawn one), open, or closed (including a tie awaiting an Admin). */
export function votingState(motion: LiveMotionState | null): VotingState {
  if (!motion || motion.status === 'withdrawn') return 'not_opened'
  if (motion.live_closed_at !== null || motion.state === 'closed') return 'closed'
  return 'open'
}

/** The latest motion for an item that is not withdrawn (the one that counts). */
export function currentMotion<T extends { status: string; created_at: string }>(motions: readonly T[]): T | null {
  const live = motions.filter((m) => m.status !== 'withdrawn')
  if (live.length === 0) return null
  return [...live].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

/** Votes still to come, or null when the count is hidden from this viewer. */
export const outstanding = (eligible: number, voted: number): number => Math.max(0, eligible - voted)

/** Validates the chair's "record for" form before asking the database. */
export function validateRecord(voter: string, option: string, note: string): string | null {
  if (!voter) return 'Choose the voter.'
  if (!(LIVE_OPTIONS as readonly string[]).includes(option)) return 'Choose Yes, No or Abstain.'
  const n = note.trim().length
  if (n < 3 || n > 300) return 'A note of 3 to 300 characters is required.'
  return null
}

/** Parses the quorum box: empty clears it (no quorum rule); otherwise a whole number 1 to 100. */
export function parseQuorum(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim()
  if (t === '') return { ok: true, value: null }
  if (!/^\d+$/.test(t)) return { ok: false }
  const v = Number(t)
  return v >= 1 && v <= 100 ? { ok: true, value: v } : { ok: false }
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  not_found: 'That vote is not available to you.',
  not_a_vote_item: 'Only a vote item can be opened for voting.',
  agenda_not_published: 'Publish the agenda before opening a vote.',
  no_wording: 'Add the exact motion wording to the item first.',
  already_opened: 'A vote has already been opened for this item.',
  motion_closed: 'This vote is closed.',
  bad_option: 'Choose Yes, No or Abstain.',
  bad_reason: 'A note of 3 to 300 characters is required.',
  own_vote: 'Use your own vote buttons for yourself.',
  not_eligible: 'That person is not an eligible voter on this vote.',
  already_voted: 'That voter has already voted.',
  recorded_by_chair: 'The chair recorded your vote, so it cannot be changed here.',
  wording_frozen: 'The wording is frozen once the vote has been opened.',
  bad_quorum: 'Quorum must be a whole number from 1 to 100.',
}

/** Maps the database's fixed error codes to words. Never echoes anything the user typed. */
export function liveMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Try again.'
}
