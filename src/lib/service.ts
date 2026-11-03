/**
 * Service record (MVA-210): date of enlistment (DOE) and mission history. A display metric only
 * (Dax ruling, 2026-10-13) -- no computed rank, no tie-break logic. Old Guard/Command compare
 * DOE, years of service and mission count by eye; a missing DOE is flagged, not computed around.
 */

export type ServiceEntry = {
  id: string
  profile_id: string
  event_date: string
  title: string
  location: string | null
  role: string | null
  notes: string | null
  source: 'app' | 'manual'
}

export const TITLE_MAX = 80
export const LOCATION_MAX = 80
export const ROLE_MAX = 60
export const NOTES_MAX = 500

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Whole years between a DOE and `now`, date-only (no time-of-day rounding). Null for a missing or unparsable DOE. */
export function yearsOfService(doe: string | null, now: Date = new Date()): number | null {
  if (!doe || !DATE_RE.test(doe)) return null
  const d = new Date(`${doe}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  let years = now.getUTCFullYear() - d.getUTCFullYear()
  const anniversary = new Date(Date.UTC(now.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  if (now.getTime() < anniversary.getTime()) years -= 1
  return Math.max(0, years)
}

export const missionCount = (entries: readonly ServiceEntry[]): number => entries.length

export type EntryFields = { event_date: string; title: string; location: string; role: string; notes: string }
export type EntryErrors = Partial<Record<keyof EntryFields, string>>

/** The fixed rules the add/edit form checks before asking the database, which enforces them again. */
export function validateEntry(f: EntryFields): EntryErrors {
  const e: EntryErrors = {}
  if (!DATE_RE.test(f.event_date)) e.event_date = 'Enter a date.'
  const title = f.title.trim()
  if (title.length === 0) e.title = 'Give the mission or event a name.'
  else if (title.length > TITLE_MAX) e.title = `At most ${TITLE_MAX} characters.`
  if (f.location.trim().length > LOCATION_MAX) e.location = `At most ${LOCATION_MAX} characters.`
  if (f.role.trim().length > ROLE_MAX) e.role = `At most ${ROLE_MAX} characters.`
  if (f.notes.trim().length > NOTES_MAX) e.notes = `At most ${NOTES_MAX} characters.`
  return e
}

/** Most senior (earliest DOE) first; a missing DOE sorts last and is flagged by the caller. */
export function sortBySeniority<T extends { doe: string | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.doe === b.doe) return 0
    if (a.doe === null) return 1
    if (b.doe === null) return -1
    return a.doe.localeCompare(b.doe)
  })
}
