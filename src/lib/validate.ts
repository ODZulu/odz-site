/**
 * Client-side validators for signup and account setup (MVA-199). They mirror the database rules
 * so the form can say what is wrong; the database is the control. Messages never echo the value.
 */

import { validatePhone } from './phone'

export const PASSWORD_MIN = 12

export { validatePhone }

const CALLSIGN = /^[A-Za-z0-9 _-]{2,24}$/

/** Lowercase letters and digits only, so case, spaces and dashes in a typed or pasted code do not matter. */
export function normalizeInviteCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Shape only. Whether a code is real is for the database to say (and it says one thing for every failure). */
export function inviteCodeShapeOk(input: string): boolean {
  return normalizeInviteCode(input).length >= 10
}

export function validateEmail(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'Enter a valid email address.'
}

export function validatePassword(password: string): string | null {
  return password.length >= PASSWORD_MIN ? null : `Use at least ${PASSWORD_MIN} characters.`
}

export function validateCallsign(callsign: string): string | null {
  if (callsign !== callsign.trim()) return 'No leading or trailing spaces.'
  return CALLSIGN.test(callsign) ? null : '2 to 24 characters: letters, digits, space, hyphen, underscore.'
}

function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** `value` is the YYYY-MM-DD string from a date input; `today` is injected for tests. */
export function validateDob(value: string, today: Date = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return 'Enter your date of birth.'
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!isRealDate(y, mo, d)) return 'That is not a real date.'
  if (y < 1900) return 'Enter your date of birth.'
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  if (Date.UTC(y, mo - 1, d) > t) return 'Date of birth cannot be in the future.'
  return null
}

export function validateRequired(value: string, label: string, max: number): string | null {
  const v = value.trim()
  if (v === '') return `${label} is required.`
  return v.length > max ? `${label} is too long.` : null
}

export type PrivateValues = {
  legalName: string
  dob: string
  phone: string
  allergies: string
  emergencyName: string
  emergencyRelationship: string
  emergencyPhone: string
}

export type SetupValues = PrivateValues & { callsign: string }

export type PrivateErrors = Partial<Record<keyof PrivateValues, string>>
export type SetupErrors = Partial<Record<keyof SetupValues, string>>

/** The private details (legal name, date of birth, phone, allergies, emergency contact). */
export function validatePrivate(v: PrivateValues, today: Date = new Date()): PrivateErrors {
  const errors: PrivateErrors = {}
  const set = (k: keyof PrivateValues, msg: string | null) => {
    if (msg) errors[k] = msg
  }
  set('legalName', validateRequired(v.legalName, 'Full legal name', 100))
  set('dob', validateDob(v.dob, today))
  set('phone', validatePhone(v.phone, false))
  set('allergies', validateRequired(v.allergies, 'Allergies (enter NKA if none)', 500))
  set('emergencyName', validateRequired(v.emergencyName, 'Emergency contact name', 100))
  set('emergencyRelationship', validateRequired(v.emergencyRelationship, 'Relationship', 50))
  set('emergencyPhone', validatePhone(v.emergencyPhone, true))
  return errors
}

export function validateSetup(v: SetupValues, today: Date = new Date()): SetupErrors {
  const errors: SetupErrors = validatePrivate(v, today)
  const callsign = validateCallsign(v.callsign)
  if (callsign) errors.callsign = callsign
  return errors
}

/** Maps the fixed error codes from complete_setup() to a form field. Anything else gets no field. */
export const setupErrorField: Record<string, keyof SetupValues> = {
  invalid_callsign: 'callsign',
  callsign_taken: 'callsign',
  invalid_legal_name: 'legalName',
  invalid_dob: 'dob',
  invalid_phone: 'phone',
  invalid_allergies: 'allergies',
  invalid_emergency_name: 'emergencyName',
  invalid_emergency_relationship: 'emergencyRelationship',
  invalid_emergency_phone: 'emergencyPhone',
}
