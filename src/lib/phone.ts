/**
 * US phone numbers in one canonical format, xxx-xxx-xxxx (MVA-207). The database normalizes and
 * checks the same way (normalize_phone); this module is for the forms and the tests. Nothing here
 * logs or echoes a value.
 */

export const PHONE_ERROR = 'Enter a 10-digit US phone number (xxx-xxx-xxxx).'

/** Digits only, with a leading US country code (1 / +1) dropped when it leaves a full number. */
function tenDigitCandidate(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
}

function hyphenate(digits: string): string {
  const a = digits.slice(0, 3)
  const b = digits.slice(3, 6)
  const c = digits.slice(6, 10)
  return [a, b, c].filter((p) => p !== '').join('-')
}

/** For the input's onChange: keeps digits, inserts hyphens after the 3rd and 6th, caps at 10. */
export function formatPhoneInput(raw: string): string {
  return hyphenate(tenDigitCandidate(raw).slice(0, 10))
}

/** The canonical `xxx-xxx-xxxx`, or null when the input is not exactly 10 digits. */
export function normalizePhone(raw: string): string | null {
  const digits = tenDigitCandidate(raw)
  return digits.length === 10 ? hyphenate(digits) : null
}

export function validatePhone(value: string, required: boolean): string | null {
  if (value.trim() === '') return required ? PHONE_ERROR : null
  return normalizePhone(value) ? null : PHONE_ERROR
}

const NO_ALLERGIES = new Set(['none', 'no', 'n/a', 'na', 'nil', 'nka'])

/** Trimmed; "none", "no", "n/a", "na", "nil" and "nka" in any case become exactly NKA. */
export function normalizeAllergies(raw: string): string {
  const t = raw.trim()
  return NO_ALLERGIES.has(t.toLowerCase()) ? 'NKA' : t
}
