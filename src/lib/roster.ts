/** Directory logic (MVA-204): ordering, search and the length rules for the profile text fields. */

export const NAME_MAX = 60
export const ROLE_MAX = 60
export const BIO_MAX = 280

export type RosterMember = {
  id: string
  callsign: string
  display_name: string | null
  role_note: string | null
  bio: string | null
  joined_at: string | null
  tier: { name: string; rank: number } | null
}

/** Most senior tier first (lower rank = more authority), then callsign A to Z ignoring case. */
export function sortRoster<T extends Pick<RosterMember, 'callsign' | 'tier'>>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    const ra = a.tier?.rank ?? Number.MAX_SAFE_INTEGER
    const rb = b.tier?.rank ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return a.callsign.localeCompare(b.callsign, 'en', { sensitivity: 'base' })
  })
}

/** Case-insensitive match on callsign. An empty query keeps everyone. */
export function filterRoster<T extends Pick<RosterMember, 'callsign'>>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  return q === '' ? members : members.filter((m) => m.callsign.toLowerCase().includes(q))
}

export function findByCallsign<T extends Pick<RosterMember, 'callsign'>>(members: T[], callsign: string): T | undefined {
  const c = callsign.trim().toLowerCase()
  return members.find((m) => m.callsign.toLowerCase() === c)
}

export const counter = (value: string, max: number): string => `${value.length}/${max}`

export type OwnProfileValues = { display_name: string; role_note: string; bio: string }
export type OwnProfileErrors = Partial<Record<keyof OwnProfileValues, string>>

export function validateOwnProfile(v: OwnProfileValues): OwnProfileErrors {
  const e: OwnProfileErrors = {}
  if (v.display_name.trim().length > NAME_MAX) e.display_name = `At most ${NAME_MAX} characters.`
  if (v.role_note.trim().length > ROLE_MAX) e.role_note = `At most ${ROLE_MAX} characters.`
  if (v.bio.trim().length > BIO_MAX) e.bio = `At most ${BIO_MAX} characters.`
  return e
}

/** Maps the fixed error codes from update_own_profile() to a field. */
export const profileErrorField: Record<string, keyof OwnProfileValues> = {
  invalid_display_name: 'display_name',
  invalid_role_note: 'role_note',
  invalid_bio: 'bio',
}
