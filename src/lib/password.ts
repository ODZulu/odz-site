/**
 * Changing your own password in the app (MVA-248). The length rule is the shared validatePassword()
 * (the same one signup uses, and the reset page of MVA-200 will use). Everything here is pure so it
 * can be tested without a DOM or a backend.
 */

import { validatePassword } from './validate'

export type PasswordChangeValues = { current: string; next: string; confirm: string }
export type PasswordChangeErrors = { current?: string; next?: string; confirm?: string }

/** Field errors for the three fields. Messages never repeat what was typed. */
export function validatePasswordChange(v: PasswordChangeValues): PasswordChangeErrors {
  const errors: PasswordChangeErrors = {}
  if (v.current === '') errors.current = 'Enter your current password.'
  const length = validatePassword(v.next)
  if (length) errors.next = length
  else if (v.next === v.current) errors.next = 'The new password must be different from the current one.'
  if (v.confirm !== v.next) errors.confirm = 'The two new passwords do not match.'
  return errors
}

export const hasErrors = (e: PasswordChangeErrors): boolean => Object.keys(e).length > 0

/** After this many wrong current passwords the form is disabled for LOCK_MS. */
export const MAX_ATTEMPTS = 5
export const LOCK_MS = 15 * 60 * 1000

export type Lockout = { fails: number; lockedUntil: number | null }
export const noLockout: Lockout = { fails: 0, lockedUntil: null }

export function isLocked(l: Lockout, now: number): boolean {
  return l.lockedUntil !== null && now < l.lockedUntil
}

export function minutesLeft(l: Lockout, now: number): number {
  return l.lockedUntil === null ? 0 : Math.max(0, Math.ceil((l.lockedUntil - now) / 60_000))
}

/** One more wrong current password. The fifth starts the lock and restarts the count. */
export function recordFailure(l: Lockout, now: number): Lockout {
  const live = l.lockedUntil !== null && now >= l.lockedUntil ? noLockout : l
  const fails = live.fails + 1
  return fails >= MAX_ATTEMPTS ? { fails: 0, lockedUntil: now + LOCK_MS } : { fails, lockedUntil: live.lockedUntil }
}

/** A correct current password clears the count. */
export const recordSuccess = (): Lockout => noLockout

const KEY = 'odz.password-lockout'

/** Per browser session (sessionStorage), so a reload does not reset the count. Supabase's own limits are the real guard. */
export function loadLockout(store: Pick<Storage, 'getItem'> | undefined = safeSession()): Lockout {
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return noLockout
    const p = JSON.parse(raw) as Partial<Lockout>
    return {
      fails: Number.isInteger(p.fails) ? Math.max(0, p.fails as number) : 0,
      lockedUntil: typeof p.lockedUntil === 'number' ? p.lockedUntil : null,
    }
  } catch {
    return noLockout
  }
}

export function saveLockout(l: Lockout, store: Pick<Storage, 'setItem'> | undefined = safeSession()): void {
  try {
    store?.setItem(KEY, JSON.stringify(l))
  } catch {
    // Storage can be unavailable (private mode); the in-memory state still applies.
  }
}

function safeSession(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** The one message for a wrong current password. It never says anything else about the account. */
export const WRONG_CURRENT = 'Current password is incorrect.'
