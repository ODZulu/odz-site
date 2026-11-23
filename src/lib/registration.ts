/**
 * Event registration and attendance (MVA-231). The database decides (event_register(), the
 * capacity and waitlist rules, the withdrawal cutoff); these helpers mirror the rules so a screen
 * can say what a button will do, and turn the database's fixed error codes into words.
 */

export type RegState = 'registered' | 'waitlisted' | 'withdrawal_requested' | 'withdrawn'
export type Attendance = 'attended' | 'no_show' | 'excused'

/** One row of event_registration_info(); none when the event does not use registration. */
export type RegistrationInfo = {
  opens_at: string
  closes_at: string | null
  capacity: number | null
  withdraw_cutoff_at: string
  confirmed: boolean
  registered_count: number
  waitlist_count: number
  no_show_count: number | null
  excused_count: number | null
  attended_count: number | null
  unmarked_count: number | null
  withdrawal_requests: number | null
  my_state: RegState | null
  my_attendance: Attendance | null
  my_position: number | null
}

export type Registrant = {
  profile_id: string
  callsign: string | null
  state: RegState
  registered_at: string
  attendance: Attendance | null
  waitlist_position: number | null
  walk_in: boolean
}

export type WindowState = 'not_open' | 'open' | 'full' | 'closed'

/** Where the registration window stands now. "full" means open but a new registrant would be waitlisted. */
export function windowState(
  info: Pick<RegistrationInfo, 'opens_at' | 'closes_at' | 'capacity' | 'registered_count'>,
  event: { starts_at: string; status: string },
  now: Date,
): WindowState {
  const t = now.getTime()
  if (event.status !== 'scheduled' || new Date(event.starts_at).getTime() <= t) return 'closed'
  if (t < new Date(info.opens_at).getTime()) return 'not_open'
  if (info.closes_at && t >= new Date(info.closes_at).getTime()) return 'closed'
  if (info.capacity !== null && info.registered_count >= info.capacity) return 'full'
  return 'open'
}

/** What pressing Withdraw will do for someone in this state. */
export function withdrawKind(
  state: RegState | null,
  cutoffAt: string,
  now: Date,
): 'withdraw' | 'request' | 'none' {
  if (state === 'waitlisted') return 'withdraw'
  if (state !== 'registered') return 'none'
  return now.getTime() < new Date(cutoffAt).getTime() ? 'withdraw' : 'request'
}

/** The event has ended (or, with no end time, started): attendance can be marked. */
export const attendanceOpen = (e: { starts_at: string; ends_at: string | null; status: string }, now: Date): boolean =>
  e.status !== 'cancelled' && new Date(e.ends_at ?? e.starts_at).getTime() < now.getTime()

export const STATE_LABEL: Record<RegState, string> = {
  registered: 'Registered',
  waitlisted: 'Waitlisted',
  withdrawal_requested: 'Withdrawal requested',
  withdrawn: 'Withdrawn',
}

export const ATTENDANCE_LABEL: Record<Attendance, string> = {
  attended: 'Attended',
  no_show: 'No-show',
  excused: 'Excused',
}

export const ATTENDANCE_CHOICES: readonly Attendance[] = ['attended', 'no_show', 'excused']

/** "3 of 10 places taken", or "3 registered" with no capacity; the waitlist when there is one. */
export function placesLine(info: Pick<RegistrationInfo, 'capacity' | 'registered_count' | 'waitlist_count'>): string {
  const base = info.capacity === null ? `${info.registered_count} registered` : `${info.registered_count} of ${info.capacity} places taken`
  return info.waitlist_count > 0 ? `${base}, ${info.waitlist_count} on the waitlist` : base
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  registration_off: 'Registration is not open for this event.',
  closed: 'Registration is closed.',
  not_open: 'Registration has not opened yet.',
  already_registered: 'Already registered.',
  not_registered: 'You are not registered.',
  already_requested: 'Your withdrawal request is already with Command.',
  no_request: 'There is no withdrawal request to decide.',
  invalid_reason: 'Give a reason (3 to 500 characters).',
  reason_required: 'Attendance is confirmed, so a change needs a reason (3 to 500 characters).',
  invalid_capacity: 'Capacity must be 1 to 1000, or empty for no limit.',
  invalid_window: 'The close time must be after the open time.',
  invalid_cutoff: 'The withdrawal cutoff cannot be after the start.',
  not_scheduled: 'Only a scheduled event can take registration.',
  not_ended: 'Attendance can be marked once the event has ended.',
  not_a_registrant: 'That member is not a registrant.',
  invalid_result: 'Choose Attended, No-show or Excused.',
  unmarked: 'Mark every registrant before confirming.',
  confirmed: 'Attendance is already confirmed.',
  'not found': 'That member or event is not available.',
}

/** Maps the database's fixed error codes to words. Never echoes anything the user typed. */
export function registrationMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Try again.'
}

export type ConfigForm = { opens: string; closes: string; capacity: string; cutoff: string }

/** Validates the Command settings form; datetime-local values are Phoenix wall-clock. */
export function validateConfig(f: ConfigForm, startsAt: string, toIso: (v: string) => string | null): Partial<Record<keyof ConfigForm, string>> {
  const e: Partial<Record<keyof ConfigForm, string>> = {}
  const opens = f.opens ? toIso(f.opens) : null
  const closes = f.closes ? toIso(f.closes) : null
  const cutoff = f.cutoff ? toIso(f.cutoff) : null
  if (f.opens && !opens) e.opens = 'Enter a valid open time.'
  if (f.closes && !closes) e.closes = 'Enter a valid close time.'
  if (f.cutoff && !cutoff) e.cutoff = 'Enter a valid cutoff.'
  if (f.capacity.trim() !== '') {
    const n = Number(f.capacity)
    if (!Number.isInteger(n) || n < 1 || n > 1000) e.capacity = 'Whole number from 1 to 1000, or leave empty.'
  }
  if (opens && closes && new Date(closes) <= new Date(opens)) e.closes = 'The close time must be after the open time.'
  if (cutoff && new Date(cutoff) > new Date(startsAt)) e.cutoff = 'The cutoff cannot be after the start.'
  return e
}
