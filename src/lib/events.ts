import { dayKey, formatDateLine, fromLocalInput } from './time'
import { supabase } from './supabase'

/**
 * Every event read and write goes through this module (MVA-201), so a later calendar sync is a
 * single adapter here and nothing else changes. Nothing calendar-vendor specific lives in the app.
 */

export const EVENT_TYPES = ['Game Day', 'Op', 'Training', 'Meeting', 'Other'] as const
export type EventType = (typeof EVENT_TYPES)[number]
export type EventStatus = 'scheduled' | 'cancelled'

/** What the public may see: that an event exists. No location, no description. */
export type PublicEvent = {
  id: string
  title: string
  event_type: EventType
  starts_at: string
  ends_at: string | null
  status: EventStatus
}

/** Members with read_event_details. */
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

export function toRow(f: EventForm) {
  return {
    title: f.title.trim(),
    event_type: f.event_type,
    starts_at: fromLocalInput(f.starts) as string,
    ends_at: f.ends ? fromLocalInput(f.ends) : null,
    location_name: f.location_name.trim() || null,
    location_detail: f.location_detail.trim() || null,
    description: f.description.trim() || null,
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
    .from('public_events')
    .select('id,title,event_type,starts_at,ends_at,status')
    .order('starts_at')
  if (error) throw new Error('events')
  return data as PublicEvent[]
}

export async function listEvents(): Promise<EventDetails[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('events')
    .select('id,title,event_type,starts_at,ends_at,status,location_name,location_detail,description')
    .order('starts_at')
  if (error) throw new Error('events')
  return data as EventDetails[]
}

export async function createEvent(form: EventForm): Promise<void> {
  if (!supabase) throw new Error('events')
  const { error } = await supabase.from('events').insert(toRow(form))
  if (error) throw new Error('events')
}

export async function updateEvent(id: string, form: EventForm): Promise<void> {
  if (!supabase) throw new Error('events')
  const { error } = await supabase.from('events').update(toRow(form)).eq('id', id)
  if (error) throw new Error('events')
}

export async function setEventStatus(id: string, status: EventStatus): Promise<void> {
  if (!supabase) throw new Error('events')
  const { error } = await supabase.from('events').update({ status }).eq('id', id)
  if (error) throw new Error('events')
}
