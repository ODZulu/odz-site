import { supabase } from './supabase'

/** HQ data and logic (MVA-142): traffic feed, RSVPs and readiness, tier breakdown. */

/* ------------------------------------------------------------------ traffic */

export const TRAFFIC_TITLE_MAX = 80
export const TRAFFIC_BODY_MAX = 1000

export type TrafficPost = {
  id: string
  title: string
  body: string
  pinned: boolean
  created_at: string
  archived_at: string | null
  author: { callsign: string | null } | null
}

/** Pinned first, then newest first. */
export function sortTraffic<T extends Pick<TrafficPost, 'pinned' | 'created_at'>>(posts: T[]): T[] {
  return [...posts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
}

export type TrafficErrors = Partial<Record<'title' | 'body', string>>

export function validateTraffic(v: { title: string; body: string }): TrafficErrors {
  const e: TrafficErrors = {}
  const title = v.title.trim()
  const body = v.body.trim()
  if (title === '') e.title = 'A title is required.'
  else if (title.length > TRAFFIC_TITLE_MAX) e.title = `At most ${TRAFFIC_TITLE_MAX} characters.`
  if (body === '') e.body = 'Write the message.'
  else if (body.length > TRAFFIC_BODY_MAX) e.body = `At most ${TRAFFIC_BODY_MAX} characters.`
  return e
}

const TRAFFIC_COLUMNS = 'id,title,body,pinned,created_at,archived_at,author:profiles(callsign)'

export async function loadTraffic(limit: number, offset = 0): Promise<{ posts: TrafficPost[]; total: number }> {
  const { data, error, count } = await supabase!
    .from('traffic')
    .select(TRAFFIC_COLUMNS, { count: 'exact' })
    .is('archived_at', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw new Error('traffic')
  return { posts: data as unknown as TrafficPost[], total: count ?? 0 }
}

export async function postTraffic(v: { title: string; body: string; pinned: boolean }): Promise<void> {
  const { error } = await supabase!.from('traffic').insert({ title: v.title.trim(), body: v.body.trim(), pinned: v.pinned })
  if (error) throw new Error('traffic')
}

export async function setTrafficPinned(id: string, pinned: boolean): Promise<void> {
  const { error } = await supabase!.from('traffic').update({ pinned }).eq('id', id)
  if (error) throw new Error('traffic')
}

export async function archiveTraffic(id: string): Promise<void> {
  const { error } = await supabase!.from('traffic').update({ archived_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error('traffic')
}

/* ------------------------------------------------------------------ rsvp and readiness */

export type Rsvp = 'in' | 'out' | 'tbd'
export const RSVP_LABEL: Record<Rsvp, string> = { in: 'IN', out: 'OUT', tbd: 'TBD' }

export type Readiness = { eligible: number; in_count: number; out_count: number; tbd_count: number; no_response: number }

export type MeterPart = { kind: 'go' | 'pending' | 'alert' | 'none'; count: number }

/** Segments for the meter, in reading order: IN, TBD, OUT, no response. Empty segments are dropped. */
export function readinessParts(r: Readiness): MeterPart[] {
  return (
    [
      { kind: 'go', count: r.in_count },
      { kind: 'pending', count: r.tbd_count },
      { kind: 'alert', count: r.out_count },
      { kind: 'none', count: r.no_response },
    ] as MeterPart[]
  ).filter((p) => p.count > 0)
}

/** "3 / 8 IN" and the share, guarding an empty roster. */
export function readinessSummary(r: Readiness): { text: string; percent: number } {
  const percent = r.eligible > 0 ? Math.round((r.in_count / r.eligible) * 100) : 0
  return { text: `${r.in_count} / ${r.eligible} IN`, percent }
}

export type RsvpRow = { profile_id: string; response: Rsvp; profile: { callsign: string | null } | null }

/** Callsigns by answer, alphabetical, ignoring case. */
export function groupRsvps(rows: RsvpRow[]): Record<Rsvp, string[]> {
  const out: Record<Rsvp, string[]> = { in: [], out: [], tbd: [] }
  for (const r of rows) if (r.profile?.callsign) out[r.response].push(r.profile.callsign)
  for (const k of Object.keys(out) as Rsvp[]) out[k].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
  return out
}

/** A member can answer until the event starts, and not at all once it is cancelled. */
export function canRsvp(e: { starts_at: string; status: string }, now: Date): boolean {
  return e.status === 'scheduled' && new Date(e.starts_at).getTime() > now.getTime()
}

export async function loadRsvps(eventId: string): Promise<RsvpRow[]> {
  const { data, error } = await supabase!
    .from('event_rsvps')
    .select('profile_id,response,profile:profiles(callsign)')
    .eq('event_id', eventId)
  if (error) throw new Error('rsvps')
  return data as unknown as RsvpRow[]
}

/**
 * Update the member's own answer, or insert the first one. Not an upsert: `upsert` would also set
 * event_id on conflict, and members hold UPDATE on `response` only. RLS limits the update to the
 * member's own row, so a zero-row result means there is no answer yet.
 */
export async function saveRsvp(eventId: string, response: Rsvp): Promise<void> {
  const rsvps = supabase!.from('event_rsvps')
  const upd = await rsvps.update({ response }).eq('event_id', eventId).select('event_id')
  if (upd.error) throw new Error('rsvps')
  if ((upd.data ?? []).length > 0) return
  const ins = await supabase!.from('event_rsvps').insert({ event_id: eventId, response })
  if (!ins.error) return
  if (ins.error.code !== '23505') throw new Error('rsvps')
  // Lost a race with another tab's first answer: it exists now, so update it.
  const again = await supabase!.from('event_rsvps').update({ response }).eq('event_id', eventId)
  if (again.error) throw new Error('rsvps')
}

export async function loadReadiness(eventId: string): Promise<Readiness> {
  const { data, error } = await supabase!.rpc('event_readiness', { p_event: eventId })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row) throw new Error('readiness')
  return row as Readiness
}

/* ------------------------------------------------------------------ tier breakdown */

export type TierCount = { tier_name: string; tier_rank: number; member_count: number }

/** Bar widths as a share of the largest tier, so the longest bar fills the row. */
export function breakdownBars(rows: TierCount[]): Array<TierCount & { share: number }> {
  const max = Math.max(1, ...rows.map((r) => r.member_count))
  return [...rows].sort((a, b) => a.tier_rank - b.tier_rank).map((r) => ({ ...r, share: r.member_count / max }))
}

export async function loadTierBreakdown(): Promise<TierCount[]> {
  const { data, error } = await supabase!.rpc('tier_breakdown')
  if (error) throw new Error('breakdown')
  return data as TierCount[]
}
