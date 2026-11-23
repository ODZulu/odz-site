import { supabase } from './supabase'
import type { EventStatus } from './events'
import type { Attendance, RegState } from './registration'

/**
 * The member's own standing on an event, in one word for the list card (MVA-301): Registered,
 * Waitlisted, Going or Attended. Reads only the member's own rows (the same rows the registration
 * panel and RSVP already read; row-level security limits them to the member).
 */
export type MyStatusInputs = {
  eventStatus: EventStatus
  registration?: { state: RegState; attendance: Attendance | null } | null
  rsvp?: 'in' | 'out' | 'tbd' | null
}

export function myStatusLabel(i: MyStatusInputs): string | null {
  const r = i.registration
  // A result shows only once the event is completed: confirming attendance completes it, so an
  // unconfirmed mark is never shown on a card.
  if (r && i.eventStatus === 'completed' && r.attendance === 'attended' && r.state !== 'withdrawn') return 'Attended'
  if (r?.state === 'registered') return 'Registered'
  if (r?.state === 'waitlisted') return 'Waitlisted'
  if (r?.state === 'withdrawal_requested') return 'Withdrawal requested'
  if (!r && i.rsvp === 'in') return 'Going'
  return null
}

type Own = { registrations: Map<string, { state: RegState; attendance: Attendance | null }>; rsvps: Map<string, 'in' | 'out' | 'tbd'> }

/** The signed-in member's registration and RSVP rows, keyed by event id. Empty when signed out or on a failure. */
export async function loadOwnStatuses(profileId: string | null | undefined): Promise<Own> {
  const own: Own = { registrations: new Map(), rsvps: new Map() }
  if (!supabase || !profileId) return own
  const [reg, rsvp] = await Promise.all([
    supabase.from('event_registrations').select('event_id,state,attendance').eq('profile_id', profileId),
    supabase.from('event_rsvps').select('event_id,response').eq('profile_id', profileId),
  ])
  for (const r of (reg.data ?? []) as { event_id: string; state: RegState; attendance: Attendance | null }[]) {
    own.registrations.set(r.event_id, { state: r.state, attendance: r.attendance })
  }
  for (const r of (rsvp.data ?? []) as { event_id: string; response: 'in' | 'out' | 'tbd' }[]) own.rsvps.set(r.event_id, r.response)
  return own
}

export function ownStatusFor(own: Own | null, eventId: string, eventStatus: EventStatus): string | null {
  if (!own) return null
  return myStatusLabel({ eventStatus, registration: own.registrations.get(eventId) ?? null, rsvp: own.rsvps.get(eventId) ?? null })
}
