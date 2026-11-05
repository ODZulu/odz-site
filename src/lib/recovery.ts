/**
 * Forgot / reset password (MVA-200 Part B). Pure helpers so the rules can be tested without a DOM
 * or a backend. Nothing here ever holds an email address, a token or a password beyond a call.
 */
import { validateEmail, validatePassword } from './validate'

/** Shown after every forgot-password request, whether or not the address has an account. */
export const NEUTRAL_RESET_MESSAGE = 'If that address has an account, a reset link is on its way.'

/** One message for an expired, reused or missing link. It says nothing about the account. */
export const LINK_PROBLEM_MESSAGE = 'This reset link is not valid any more. Request a new one.'

/** Shown on the login screen after a successful reset. */
export const RESET_DONE_NOTICE = 'Your password was changed. Sign in with the new password.'

export const resetUrl = (origin: string): string => `${origin}/reset-password`

/** The only client-side check on the forgot form: a well-formed address. It reveals nothing about accounts. */
export const validateForgot = (email: string): string | null => validateEmail(email)

export type ResetErrors = { password?: string; confirm?: string }

/** Same length rule as signup (validatePassword), plus a matching confirm field. */
export function validateReset(password: string, confirm: string): ResetErrors {
  const errors: ResetErrors = {}
  const length = validatePassword(password)
  if (length) errors.password = length
  if (confirm !== password) errors.confirm = 'The two passwords do not match.'
  return errors
}

export const hasResetErrors = (e: ResetErrors): boolean => Object.keys(e).length > 0

/**
 * The reset page is for a recovery session only. A session from an ordinary sign-in must not be
 * able to set a new password here without the current one, so the page needs proof that this tab
 * arrived through a recovery link: Supabase's PASSWORD_RECOVERY event, remembered for the tab.
 */
const KEY = 'odz.recovery'
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function tabStore(): Store | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

export function markRecovery(store: Store | undefined = tabStore()): void {
  try {
    store?.setItem(KEY, '1')
  } catch {
    // Storage can be unavailable (private mode); the link then has to be opened again.
  }
}

export function hasRecovery(store: Store | undefined = tabStore()): boolean {
  try {
    return store?.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function clearRecovery(store: Store | undefined = tabStore()): void {
  try {
    store?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
