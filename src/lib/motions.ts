/**
 * Motions and votes (MVA-233). The database decides everything (the rules live in
 * motion_evaluate()); these helpers mirror them so the screens can show the state of play, and are
 * tested against the same cases as the SQL.
 */

export type MotionState = 'draft' | 'open' | 'closed'
export type MotionStatus = 'open' | 'decided' | 'escalated' | 'escalated_final' | 'withdrawn'
export type MotionBody = 'command' | 'old_guard'

export type Motion = {
  id: string
  type: string
  title: string
  description: string
  subject_type: string | null
  subject_id: string | null
  parent_type: string | null
  parent_id: string | null
  options: string[]
  body: MotionBody
  round: number
  deadline_hours: number
  deadline: string | null
  state: MotionState
  status: MotionStatus
  opened_by: string
  opened_by_callsign: string | null
  opened_at: string | null
  outcome_option: string | null
  decided_at: string | null
  decided_final_by: string | null
  decided_final_reason: string | null
  withdraw_reason: string | null
  created_at: string
}

export type MotionVote = { round: number; voter_id: string; voter_callsign: string | null; option: string; updated_at: string }

export const DEFAULT_OPTIONS = ['Approve', 'Reject'] as const
export const DEFAULT_DEADLINE_HOURS = 72
/** Fewer eligible voters than this and the round escalates at once. */
export const MIN_VOTERS = 3
export const REASON_MIN = 3

/** Strict majority of ALL eligible voters, not of the votes cast. */
export const isStrictMajority = (count: number, eligible: number): boolean => count * 2 > eligible

export function tally(options: readonly string[], votes: readonly { option: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const o of options) out[o] = 0
  for (const v of votes) if (v.option in out) out[v.option] += 1
  return out
}

export type Outlook =
  | { kind: 'decided'; winner: string }
  | { kind: 'tie'; reason: 'too_few_voters' | 'no_majority_possible' }
  | { kind: 'pending' }

/**
 * Where a round stands: decided (a strict majority on one option, which closes it early), a tie
 * (fewer than 3 eligible voters, or no option can still reach a majority) or still pending.
 */
export function outlook(options: readonly string[], votes: readonly { option: string }[], eligible: number): Outlook {
  if (eligible < MIN_VOTERS) return { kind: 'tie', reason: 'too_few_voters' }
  const counts = tally(options, votes)
  for (const o of options) if (isStrictMajority(counts[o], eligible)) return { kind: 'decided', winner: o }
  const remaining = eligible - votes.length
  const someoneCanStillWin = options.some((o) => isStrictMajority(counts[o] + remaining, eligible))
  return someoneCanStillWin ? { kind: 'pending' } : { kind: 'tie', reason: 'no_majority_possible' }
}

/** At the deadline an undecided round is a tie, however close the count. */
export function atDeadline(options: readonly string[], votes: readonly { option: string }[], eligible: number): Outlook {
  const o = outlook(options, votes, eligible)
  return o.kind === 'pending' ? { kind: 'tie', reason: 'no_majority_possible' } : o
}

/** What follows a tie: Command goes to the Old Guard, the Old Guard to an Admin. */
export function afterTie(body: MotionBody): 'old_guard' | 'admin' {
  return body === 'command' ? 'old_guard' : 'admin'
}

export type Candidate = { id: string; seatGroup: 'command' | 'old_guard' | null; status: string }

/** The eligible-voter rule used when a round starts: the body, minus parties and prior recusals, approved accounts only. */
export function eligibleVoters(
  body: MotionBody,
  members: readonly Candidate[],
  parties: readonly string[],
  recused: readonly string[],
): string[] {
  return members
    .filter((m) => m.status === 'approved')
    .filter((m) => (body === 'command' ? m.seatGroup === 'command' : m.seatGroup === 'command' || m.seatGroup === 'old_guard'))
    .filter((m) => !parties.includes(m.id) && !recused.includes(m.id))
    .map((m) => m.id)
}

export const bodyLabel = (b: MotionBody): string => (b === 'command' ? 'Command' : 'Old Guard')

export function statusLabel(m: Pick<Motion, 'state' | 'status' | 'round'>): string {
  if (m.state === 'draft') return 'DRAFT'
  switch (m.status) {
    case 'decided':
      return 'DECIDED'
    case 'withdrawn':
      return 'WITHDRAWN'
    case 'escalated':
      return 'ESCALATED: OLD GUARD VOTING'
    case 'escalated_final':
      return 'AWAITING ADMIN DECISION'
    default:
      return 'OPEN'
  }
}

/** Filters on the Motions page. */
export type MotionFilter = 'all' | 'open' | 'closed' | 'mine'
export function filterMotions<T extends Pick<Motion, 'state' | 'opened_by'>>(
  motions: readonly T[],
  filter: MotionFilter,
  selfId: string | undefined,
): T[] {
  switch (filter) {
    case 'open':
      return motions.filter((m) => m.state !== 'closed')
    case 'closed':
      return motions.filter((m) => m.state === 'closed')
    case 'mine':
      return motions.filter((m) => m.opened_by === selfId)
    default:
      return [...motions]
  }
}

/** Time left, in words. */
export function timeLeft(deadline: string | null, now: number = Date.now()): string | null {
  if (!deadline) return null
  const ms = new Date(deadline).getTime() - now
  if (ms <= 0) return 'deadline passed'
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 48) return `${Math.floor(hours / 24)} days left`
  if (hours >= 1) return `${hours} h left`
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`
}

/** Parses the options box (one per line). Returns null when it is not a valid 2 to 6 distinct list. */
export function parseOptions(text: string): string[] | null {
  const items = text.split('\n').map((s) => s.trim()).filter(Boolean)
  if (items.length < 2 || items.length > 6) return null
  if (new Set(items).size !== items.length) return null
  if (items.some((s) => s.length > 40)) return null
  return items
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  not_found: 'That motion is not available to you.',
  not_eligible: 'You are not an eligible voter on this motion.',
  motion_closed: 'This motion is no longer open for votes.',
  bad_option: 'That is not one of the options.',
  bad_options: 'Options must be 2 to 6 different choices, each up to 40 characters.',
  bad_body: 'Choose Command or the Old Guard.',
  bad_reason: `Give a reason (${REASON_MIN} to 300 characters).`,
  already_voted: 'You have already voted, so you can no longer recuse.',
  votes_cast: 'A vote has been cast, so the motion can no longer be withdrawn.',
  not_a_draft: 'That motion is not a draft.',
  not_awaiting_final: 'That motion is not waiting for an Admin decision.',
}

/** Maps the database's fixed error codes to words. Never echoes anything the user typed. */
export function motionMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Try again.'
}
