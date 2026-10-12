import { dayKey, formatDateLine, fromLocalInput } from './time'
import { supabase } from './supabase'

/**
 * Every event read and write goes through this module (MVA-201), so a later calendar sync is a
 * single adapter here and nothing else changes. Nothing calendar-vendor specific lives in the app.
 */

export const EVENT_TYPES = ['Game Day', 'Op', 'Training', 'Meeting', 'Other'] as const
export type EventType = (typeof EVENT_TYPES)[number]
export type EventStatus = 'scheduled' | 'cancelled'

/** What anyone may see (the `events` table): that an event exists. No location, no description. */
export type PublicEvent = {
  id: string
  title: string
  event_type: EventType
  starts_at: string
  ends_at: string | null
  status: EventStatus
}

/** Members with read_event_details also get the `event_details` row (location, directions, description). */
export type EventDetails = PublicEvent & {
  location_name: string | null
  location_detail: string | null
  description: string | null
}

export type EventForm = {
  title: string
  event_type: EventType
  /** Phoenix wall-clock `datetime-local` values */
  starts: string
  ends: string
  location_name: string
  location_detail: string
  description: string
}

export const emptyEventForm: EventForm = {
  title: '',
  event_type: 'Other',
  starts: '',
  ends: '',
  location_name: '',
  location_detail: '',
  description: '',
}

export type EventErrors = Partial<Record<keyof EventForm, string>>

export function validateEventForm(f: EventForm): EventErrors {
  const e: EventErrors = {}
  if (f.title.trim() === '') e.title = 'Title is required.'
  else if (f.title.trim().length > 120) e.title = 'Title is too long.'
  const start = fromLocalInput(f.starts)
  if (!start) e.starts = 'Enter a start time.'
  if (f.ends) {
    const end = fromLocalInput(f.ends)
    if (!end) e.ends = 'Enter a valid end time.'
    else if (start && new Date(end) <= new Date(start)) e.ends = 'The end must be after the start.'
  }
  if (f.location_name.length > 120) e.location_name = 'Too long.'
  if (f.location_detail.length > 1000) e.location_detail = 'Too long (1000 characters).'
  if (f.description.length > 5000) e.description = 'Too long (5000 characters).'
  return e
}

/** The arguments of the save_event() RPC: the event and its details, saved together. */
export function toSaveArgs(id: string | null, f: EventForm) {
  return {
    p_id: id,
    p_title: f.title.trim(),
    p_event_type: f.event_type,
    p_starts_at: fromLocalInput(f.starts) as string,
    p_ends_at: f.ends ? fromLocalInput(f.ends) : null,
    p_location_name: f.location_name.trim() || null,
    p_location_detail: f.location_detail.trim() || null,
    p_description: f.description.trim() || null,
  }
}

/** An event is past once it has ended (or, with no end time, once it has started). */
export function isPast(e: Pick<PublicEvent, 'starts_at' | 'ends_at'>, now: Date): boolean {
  return new Date(e.ends_at ?? e.starts_at).getTime() < now.getTime()
}

export function splitUpcoming<T extends Pick<PublicEvent, 'starts_at' | 'ends_at'>>(
  events: T[],
  now: Date,
): { upcoming: T[]; past: T[] } {
  const byStart = (a: T, b: T) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
  const upcoming = events.filter((e) => !isPast(e, now)).sort(byStart)
  const past = events.filter((e) => isPast(e, now)).sort((a, b) => byStart(b, a))
  return { upcoming, past }
}

export function groupByDay<T extends Pick<PublicEvent, 'starts_at'>>(events: T[]): Array<{ key: string; label: string; events: T[] }> {
  const groups: Array<{ key: string; label: string; events: T[] }> = []
  for (const e of events) {
    const key = dayKey(e.starts_at)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.events.push(e)
    else groups.push({ key, label: formatDateLine(e.starts_at), events: [e] })
  }
  return groups
}

/* ---------------------------------------------------------------- reads and writes */

export async function listPublicEvents(): Promise<PublicEvent[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('events')
    .select('id,title,event_type,starts_at,ends_at,status')
    .order('starts_at')
  if (error) throw new Error('events')
  return data as PublicEvent[]
}

type EventWithDetails = PublicEvent & {
  event_details: { location_name: string | null; location_detail: string | null; description: string | null } | null
}

/** Joins each event to its details row; a caller without read_event_details gets null details. */
export function flattenDetails(rows: EventWithDetails[]): EventDetails[] {
  return rows.map(({ event_details: d, ...e }) => ({
    ...e,
    location_name: d?.location_name ?? null,
    location_detail: d?.location_detail ?? null,
    description: d?.description ?? null,
  }))
}

export async function listEvents(): Promise<EventDetails[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('events')
    .select('id,title,event_type,starts_at,ends_at,status,event_details(location_name,location_detail,description)')
    .order('starts_at')
  if (error) throw new Error('events')
  return flattenDetails(data as unknown as EventWithDetails[])
}

export async function createEvent(form: EventForm): Promise<void> {
  if (!supabase) throw new Error('events')
  const { error } = await supabase.rpc('save_event', toSaveArgs(null, form))
  if (error) throw new Error('events')
}

export async function updateEvent(id: string, form: EventForm): Promise<void> {
  if (!supabase) throw new Error('events')
  const { error } = await supabase.rpc('save_event', toSaveArgs(id, form))
  if (error) throw new Error('events')
}

export async function setEventStatus(id: string, status: EventStatus): Promise<void> {
  if (!supabase) throw new Error('events')
  const { error } = await supabase.from('events').update({ status }).eq('id', id)
  if (error) throw new Error('events')
}
