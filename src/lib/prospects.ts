/**
 * Prospects (MVA-260): open opportunities shown beside real events in the calendar and the HQ
 * schedule. A prospect is only ever a marker. It is never an event, so it never carries RSVP,
 * registration or readiness. Pure helpers only; the data comes from opportunity_list() (members and
 * above, enforced by the database) and the screens decide what to draw.
 */
import { supabase } from './supabase'
import { dayKey } from './time'
import type { Opportunity } from './opportunities'

/** The slice of an opportunity a schedule row needs. */
export type Prospect = Pick<Opportunity, 'id' | 'title' | 'starts_on' | 'ends_on' | 'location_text'>

/** A schedule row: a real event, or a prospect. Events come first within a day. */
export type ScheduleItem<E extends { starts_at: string }> =
  | { kind: 'event'; day: string; at: string; event: E }
  | { kind: 'prospect'; day: string; at: string; prospect: Prospect }

/** Open opportunities that have not finished yet, soonest first. Promoted, dropped and expired are not prospects. */
export function upcomingProspects(rows: readonly Opportunity[], now: Date): Prospect[] {
  const today = dayKey(now)
  return rows
    .filter((o) => o.status === 'open' && (o.ends_on ?? o.starts_on) >= today)
    .sort((a, b) => (a.starts_on === b.starts_on ? 0 : a.starts_on < b.starts_on ? -1 : 1))
    .map(({ id, title, starts_on, ends_on, location_text }) => ({ id, title, starts_on, ends_on, location_text }))
}

/**
 * Events (already upcoming) and prospects as one list in date order. A multi-day prospect sits on
 * its first day, or on today once that day has passed but it has not ended.
 */
export function mergeSchedule<E extends { starts_at: string }>(
  events: readonly E[],
  prospects: readonly Prospect[],
  now: Date,
): Array<ScheduleItem<E>> {
  const today = dayKey(now)
  const items: Array<ScheduleItem<E>> = [
    ...events.map((event) => ({ kind: 'event' as const, day: dayKey(event.starts_at), at: event.starts_at, event })),
    ...prospects.map((prospect) => ({
      kind: 'prospect' as const,
      day: prospect.starts_on < today ? today : prospect.starts_on,
      at: prospect.starts_on,
      prospect,
    })),
  ]
  const rank = (i: ScheduleItem<E>) => (i.kind === 'event' ? 0 : 1)
  return items.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.kind === 'event' && b.kind === 'event' ? new Date(a.at).getTime() - new Date(b.at).getTime() : 0
  })
}

/** Items grouped by Phoenix day, in order. */
export function groupScheduleByDay<E extends { starts_at: string }>(
  items: ReadonlyArray<ScheduleItem<E>>,
): Array<{ key: string; items: Array<ScheduleItem<E>> }> {
  const groups: Array<{ key: string; items: Array<ScheduleItem<E>> }> = []
  for (const i of items) {
    const last = groups[groups.length - 1]
    if (last && last.key === i.day) last.items.push(i)
    else groups.push({ key: i.day, items: [i] })
  }
  return groups
}

/** Where tapping a prospect goes: the Opportunities page, scrolled to that card. */
export const prospectHref = (id: string): string => `/opportunities#opp-${id}`

/** The card id on the Opportunities page, and the reverse for a location hash. */
export const prospectAnchor = (id: string): string => `opp-${id}`
export const idFromHash = (hash: string): string | null => (/^#opp-[0-9a-f-]{36}$/i.test(hash) ? hash.slice(5) : null)

/**
 * Loads the opportunity list for the schedule. A failure or a missing client yields no prospects:
 * the calendar and hub must still show real events. Callers skip this when the member lacks
 * read_opportunities; the database refuses them anyway.
 */
export async function loadProspects(now: Date): Promise<Prospect[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('opportunity_list')
  if (error || !data) return []
  return upcomingProspects(data as Opportunity[], now)
}
