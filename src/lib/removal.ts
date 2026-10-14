/** Member removal (MVA-209): the rules the screens check before asking the database, which enforces them again. */

export const REASON_MIN = 3
export const REASON_MAX = 500

/** Returns a message for a reason that would be refused, or null. The reason is trimmed first, as the database does. */
export function validateReason(reason: string): string | null {
  const n = reason.trim().length
  if (n < REASON_MIN) return `Give a reason of at least ${REASON_MIN} characters.`
  if (n > REASON_MAX) return `At most ${REASON_MAX} characters.`
  return null
}

export type RemovalTarget = {
  id: string
  is_admin: boolean
  status: string
}

/**
 * Why this member cannot be removed from this screen, or null if the action may be offered.
 * Admin only: Command can see the roster but not this action. A removal of the only approved
 * Admin is refused by the database; this just keeps the button from being offered.
 */
export function removalBlock(opts: {
  isAdmin: boolean
  selfId: string | undefined
  target: RemovalTarget
  approvedAdmins: number
}): string | null {
  const { isAdmin, selfId, target, approvedAdmins } = opts
  if (!isAdmin) return 'Only an Admin can remove a member.'
  if (target.status === 'removed') return 'This member is already removed.'
  if (target.id === selfId) return 'You cannot remove yourself.'
  if (target.is_admin && target.status === 'approved' && approvedAdmins <= 1) return 'There must always be one Admin.'
  return null
}

/** Hard delete asks for the callsign typed back, on top of the confirm step. Case-sensitive, as shown. */
export const confirmsCallsign = (typed: string, callsign: string | null): boolean =>
  callsign !== null && callsign !== '' && typed.trim() === callsign
