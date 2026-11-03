/** Reinstating a soft-removed member (MVA-249): what the screen tells the Admin before asking the database. */

import { adminMessage } from './admin'
import { REASON_MAX, validateReason } from './removal'

export { REASON_MAX, validateReason }

export type PreviousTier = { name: string; seat_group: 'old_guard' | 'command' | null } | null

/**
 * The tier a reinstated member comes back in. A seat tier (Old Guard, Command) returns as Member:
 * seats are re-granted only through the normal promotion path with the seat caps, never by
 * reinstatement. Every other tier is restored. The database makes the same decision.
 */
export function reinstatedTierName(previous: PreviousTier, memberTierName = 'Member'): string {
  if (!previous) return memberTierName
  return previous.seat_group ? memberTierName : previous.name
}

/** What the confirmation says. */
export function reinstateNotice(callsign: string, previous: PreviousTier): string {
  const tier = reinstatedTierName(previous)
  const seat = previous?.seat_group ? ` Their ${previous.name} seat is not restored; it needs a promotion through the seat caps.` : ''
  return (
    `${callsign} can sign in again and returns as ${tier}.${seat} They must redo the first-login setup form. ` +
    `Designations are not restored; their service record is. Revoked invites stay revoked. This is logged with your reason.`
  )
}

/** Translates a reinstate_member refusal. A missing function (migration not applied) gets its own message. */
export function reinstateMessage(error: { message?: string } | null | undefined): string {
  const m = error?.message ?? ''
  if (m === 'not_reinstatable') return 'Only a removed member can be reinstated. Reload and try again.'
  if (/schema cache|could not find the function/i.test(m)) {
    return 'Reinstating is not available on this database; the migration may be missing.'
  }
  return adminMessage(error)
}
