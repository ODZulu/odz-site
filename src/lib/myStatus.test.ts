import { describe, expect, it, vi } from 'vitest'

// The module imports the Supabase client; keep these tests independent of local env files.
vi.mock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

import { myStatusLabel } from './myStatus'

describe('myStatusLabel', () => {
  it('shows registration states in words', () => {
    expect(myStatusLabel({ eventStatus: 'scheduled', registration: { state: 'registered', attendance: null } })).toBe('Registered')
    expect(myStatusLabel({ eventStatus: 'scheduled', registration: { state: 'waitlisted', attendance: null } })).toBe('Waitlisted')
    expect(myStatusLabel({ eventStatus: 'scheduled', registration: { state: 'withdrawal_requested', attendance: null } })).toBe('Withdrawal requested')
  })
  it('shows nothing for a withdrawn registration', () => {
    expect(myStatusLabel({ eventStatus: 'scheduled', registration: { state: 'withdrawn', attendance: null } })).toBeNull()
  })
  it('shows Going for an In answer on an event without registration', () => {
    expect(myStatusLabel({ eventStatus: 'scheduled', rsvp: 'in' })).toBe('Going')
    expect(myStatusLabel({ eventStatus: 'scheduled', rsvp: 'out' })).toBeNull()
    expect(myStatusLabel({ eventStatus: 'scheduled', rsvp: 'tbd' })).toBeNull()
  })
  it('shows Attended only once the event is completed', () => {
    const registration = { state: 'registered' as const, attendance: 'attended' as const }
    expect(myStatusLabel({ eventStatus: 'completed', registration })).toBe('Attended')
    expect(myStatusLabel({ eventStatus: 'scheduled', registration })).toBe('Registered')
  })
  it('never shows a no-show or excused result on a card', () => {
    expect(myStatusLabel({ eventStatus: 'completed', registration: { state: 'registered', attendance: 'no_show' } })).toBe('Registered')
    expect(myStatusLabel({ eventStatus: 'completed', registration: { state: 'registered', attendance: 'excused' } })).toBe('Registered')
  })
  it('shows nothing when there is no answer', () => expect(myStatusLabel({ eventStatus: 'scheduled' })).toBeNull())
})
