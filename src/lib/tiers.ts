/**
 * Role-based tiers (MVA-237). Support is a tier outside the player progression. Which tiers are
 * role-based, and which may never be moved to or from one, is data on the tier (role_based,
 * support_barred), not a name check. The database enforces every rule here (move_support_tier and
 * the profiles guard); these helpers let the screens say what a move needs before asking.
 */

export const TIER_NOTE_MIN = 3
export const TIER_NOTE_MAX = 300

export type TierFlags = { id: string; name: string; role_based: boolean; support_barred: boolean }

/** True when going from `from` to `to` crosses the player/role-based line, so it needs a logged note. */
export function crossesSupportLine(from: TierFlags | undefined, to: TierFlags | undefined): boolean {
  if (!from || !to) return false
  return from.role_based !== to.role_based
}

/** Why a cross-line move is not offered, or null if it can go ahead (with a note). */
export function supportMoveBlock(from: TierFlags, to: TierFlags): string | null {
  if (!crossesSupportLine(from, to)) return null
  if (from.support_barred || to.support_barred) {
    return `${from.support_barred ? from.name : to.name} cannot be moved to or from a role-based tier directly. Change the player tier first.`
  }
  return null
}

export function validateTierNote(note: string): string | null {
  const n = note.trim().length
  if (n < TIER_NOTE_MIN) return `Write a note of at least ${TIER_NOTE_MIN} characters.`
  return n > TIER_NOTE_MAX ? `At most ${TIER_NOTE_MAX} characters.` : null
}

/** The tier an invite defaults to: the last player tier in rank order that invites may grant. */
export function defaultInviteTier<T extends { id: string; invitable: boolean; role_based: boolean; rank: number }>(tiers: T[]): string {
  const eligible = tiers.filter((t) => t.invitable && !t.role_based)
  if (eligible.length === 0) return ''
  return eligible.reduce((a, b) => (b.rank > a.rank ? b : a)).id
}

/** Shown wherever the ladder is listed. */
export const ROLE_BASED_NOTE = 'Role-based tier: not a seniority rank, no vote. It sits outside the player progression.'
