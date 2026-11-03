/** Designations (MVA-220): duty roles layered on top of the rank ladder. The database enforces
 * eligibility, the holder cap and who may assign or revoke; these helpers format what the screens
 * show and filter the roster. */

export type Designation = {
  id: string
  name: string
  description: string
  capability_key: string
  office_seat: boolean
  max_holders: number
}

export type MemberDesignation = { profile_id: string; designation_id: string }

/** Designation names a profile holds, most senior catalog order first. */
export function designationNamesFor(
  profileId: string,
  assignments: readonly MemberDesignation[],
  catalog: readonly Designation[],
): string[] {
  const held = new Set(assignments.filter((a) => a.profile_id === profileId).map((a) => a.designation_id))
  return catalog.filter((d) => held.has(d.id)).map((d) => d.name)
}

/** Keeps only members holding the given designation id; null or '' keeps everyone. */
export function filterByDesignation<T extends { id: string }>(
  members: readonly T[],
  assignments: readonly MemberDesignation[],
  designationId: string | null,
): T[] {
  if (!designationId) return [...members]
  const holders = new Set(assignments.filter((a) => a.designation_id === designationId).map((a) => a.profile_id))
  return members.filter((m) => holders.has(m.id))
}

export const isVacant = (holderCount: number): boolean => holderCount === 0

/** Designations a profile does not already hold, for an "assign" picker. */
export function assignableTo(profileId: string, assignments: readonly MemberDesignation[], catalog: readonly Designation[]): Designation[] {
  const held = new Set(assignments.filter((a) => a.profile_id === profileId).map((a) => a.designation_id))
  return catalog.filter((d) => !held.has(d.id))
}
