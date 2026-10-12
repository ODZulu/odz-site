/**
 * Pure logic behind the admin area (MVA-141). The database enforces every rule here; these
 * helpers let the screens explain a refusal before asking, and decide what to show.
 */

export const CONFIRM_WORD = 'PRIVATE'
export const PRIVATE_CAPABILITY = 'view_member_private'
export const LOCKOUT_CAPABILITY = 'approve_members'

export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked'

/** Everything but the last four characters is hidden once an invite has been created. */
export function maskCode(hint: string): string {
  return `**** **** **** ${hint}`
}

/** The full code, grouped for reading aloud. Shown only once, right after creation. */
export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

export function joinLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/join/${code}`
}

export const EXPIRY_MIN_DAYS = 1
export const EXPIRY_MAX_DAYS = 30
export const EXPIRY_DEFAULT_DAYS = 7

export function validateExpiryDays(value: number): string | null {
  if (!Number.isInteger(value)) return 'Enter a whole number of days.'
  if (value < EXPIRY_MIN_DAYS || value > EXPIRY_MAX_DAYS) {
    return `Expiry must be ${EXPIRY_MIN_DAYS} to ${EXPIRY_MAX_DAYS} days.`
  }
  return null
}

/** tier id -> capability keys it holds */
export type CapMatrix = Record<string, string[]>

export function holdersOf(matrix: CapMatrix, cap: string): string[] {
  return Object.keys(matrix).filter((tier) => matrix[tier].includes(cap))
}

/** True when switching `cap` off for `tierId` would leave no tier able to approve members. */
export function removalLocksOut(matrix: CapMatrix, tierId: string, cap: string): boolean {
  if (cap !== LOCKOUT_CAPABILITY) return false
  const holders = holdersOf(matrix, cap)
  return holders.length === 1 && holders[0] === tierId
}

export function toggleCap(matrix: CapMatrix, tierId: string, cap: string, enabled: boolean): CapMatrix {
  const current = matrix[tierId] ?? []
  const next = enabled ? (current.includes(cap) ? current : [...current, cap]) : current.filter((c) => c !== cap)
  return { ...matrix, [tierId]: next }
}

export const needsTypedConfirm = (cap: string): boolean => cap === PRIVATE_CAPABILITY

export const confirmMatches = (input: string): boolean => input === CONFIRM_WORD

/** Moves `id` one place up (more senior) or down. Returns the same order at the ends. */
export function moveId(ids: string[], id: string, dir: 'up' | 'down'): string[] {
  const i = ids.indexOf(id)
  const j = dir === 'up' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= ids.length) return ids
  const next = [...ids]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export type Section = 'invites' | 'pending' | 'members' | 'tiers' | 'audit'

export const sectionLabels: Record<Section, string> = {
  invites: 'Invites',
  pending: 'Pending',
  members: 'Members',
  tiers: 'Tiers',
  audit: 'Audit',
}

/** Which sections of /admin an account may open. Admin sees everything. */
export function visibleSections(caps: readonly string[], isAdmin: boolean): Section[] {
  const has = (c: string) => isAdmin || caps.includes(c)
  const out: Section[] = []
  if (has('approve_members')) out.push('invites', 'pending')
  if (has('edit_roster')) out.push('members')
  if (isAdmin) out.push('tiers')
  if (has('approve_members') || has('edit_roster')) out.push('audit')
  return out
}

const messages: Array<[needle: string, text: string]> = [
  ['approve_members_lockout', 'Approving members must stay switched on for at least one tier.'],
  ['tier_has_members', 'That tier still has members. Move them first.'],
  ['tier_in_rules', 'That tier is part of the Command entry and release rules.'],
  ['name_taken', 'A tier with that name already exists.'],
  ['invalid_name', 'Use a name of 1 to 30 characters.'],
  ['confirmation_required', 'Type PRIVATE to confirm this change.'],
  ['invalid_order', 'The tier order was not valid. Reload and try again.'],
  ['invalid_days', 'Expiry must be 1 to 30 days.'],
  ['last admin', 'There must always be one admin.'],
  ['own tier', 'You cannot change your own tier.'],
  ['own status', 'You cannot change your own status.'],
  ['prerequisite', 'That tier needs its prerequisite tier first (Command is entered from Old Guard).'],
  ['not allowed', 'You are not allowed to do that.'],
]

/** Friendly text for a database refusal. Unknown errors get a generic line and nothing else. */
export function adminMessage(error: { message?: string } | null | undefined): string {
  const m = error?.message ?? ''
  const hit = messages.find(([needle]) => m.includes(needle))
  return hit ? hit[1] : 'That change was refused.'
}
