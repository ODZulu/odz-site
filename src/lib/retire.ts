/** Retired status (MVA-238): the rules the screens check before asking the database, which enforces them again. */

import { adminMessage } from './admin'
import { vacancies, type SeatCounts } from './seats'

export const RETIRE_REASON_MAX = 300

/** The reason is optional; if given it is trimmed and capped, as the database does. */
export function validateRetireReason(reason: string): string | null {
  return reason.trim().length > RETIRE_REASON_MAX ? `At most ${RETIRE_REASON_MAX} characters.` : null
}

export type RetireTarget = { id: string; is_admin: boolean; status: string }

/**
 * Why this member cannot be retired from this screen, or null if the action may be offered.
 * Command and Admin (edit_roster) retire; only an Admin retires an Admin.
 */
export function retireBlock(opts: {
  canEdit: boolean
  isAdmin: boolean
  selfId: string | undefined
  target: RetireTarget
}): string | null {
  const { canEdit, isAdmin, selfId, target } = opts
  if (!canEdit) return 'Only Command or an Admin can retire a member.'
  if (target.id === selfId) return 'You cannot retire yourself.'
  if (target.status === 'retired') return 'This member is already retired.'
  if (target.status !== 'approved' && target.status !== 'suspended') return 'Only an active member can be retired.'
  if (target.is_admin && !isAdmin) return 'Only an Admin can retire an Admin.'
  return null
}

/** What the confirmation says. Duty roles come first because they are the part that is not undone on return. */
export function retireWarning(callsign: string, vacated: readonly string[]): string {
  const roles =
    vacated.length > 0
      ? `${callsign} will lose these designations and office seats, and they are not restored on return: ${vacated.join(', ')}. `
      : ''
  return (
    roles +
    `${callsign} keeps a limited sign-in (own profile, Traffic and notifications), leaves the active roster and every tally, ` +
    `and frees their Old Guard or Command seat. Their service record is kept. This is logged.`
  )
}

export type TierOption = {
  id: string
  name: string
  rank: number
  seat_group: 'old_guard' | 'command' | null
  role_based: boolean
  entry_requires_tier_id: string | null
}

/**
 * Tiers Command may return a retired member to when the prior tier's seat is full: player tiers
 * (never role-based Support), not the tier already refused, with room in their seat group, and
 * whose entry rule is met by the tier the member holds now. The database checks all of it again.
 */
export function returnTierOptions(opts: {
  tiers: readonly TierOption[]
  counts: SeatCounts | null
  currentTierId: string | null
}): TierOption[] {
  const { tiers, counts, currentTierId } = opts
  const open = counts ? vacancies(counts) : null
  return tiers
    .filter((t) => {
      if (t.role_based || t.id === currentTierId) return false
      if (t.entry_requires_tier_id && t.entry_requires_tier_id !== currentTierId) return false
      if (open && t.seat_group === 'command' && open.command <= 0) return false
      // Command counts inside Old Guard, so either seat group needs an open Old Guard seat.
      if (open && t.seat_group && open.oldGuard <= 0) return false
      return true
    })
    .sort((a, b) => a.rank - b.rank)
}

export const PICK_TIER_MESSAGE = 'Pick a tier to restore this member to'

/** True when the refusal was a missing or unusable tier, so the screen can ask for one. */
export const isTierMissing = (error: { message?: string } | null | undefined): boolean => error?.message === 'invalid_tier'

/** Translates a retire / unretire refusal into a message to show. */
export function retireMessage(error: { message?: string } | null | undefined): string {
  const m = error?.message ?? ''
  if (m === 'invalid_tier') return PICK_TIER_MESSAGE
  if (m === 'invalid_reason') return `Keep the reason to ${RETIRE_REASON_MAX} characters.`
  if (/schema cache|could not find the function/i.test(m)) {
    return 'Retiring is not available on this database; the migration may be missing.'
  }
  return adminMessage(error)
}

/** True when the refusal was a full seat, so the screen can offer another tier. */
export const isSeatFull = (error: { message?: string } | null | undefined): boolean =>
  /(Old Guard|Command) is full: \d+\/\d+/.test(error?.message ?? '')
