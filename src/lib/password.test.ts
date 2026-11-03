import { describe, expect, it } from 'vitest'
import {
  hasErrors,
  isLocked,
  loadLockout,
  LOCK_MS,
  MAX_ATTEMPTS,
  minutesLeft,
  noLockout,
  recordFailure,
  recordSuccess,
  saveLockout,
  validatePasswordChange,
  WRONG_CURRENT,
} from './password'

const ok = { current: 'old-fake-password-1', next: 'new-fake-password-2', confirm: 'new-fake-password-2' }

describe('validatePasswordChange', () => {
  it('accepts a valid change', () => expect(hasErrors(validatePasswordChange(ok))).toBe(false))
  it('rejects 11 characters and accepts 12 (the shared signup rule)', () => {
    const eleven = 'a'.repeat(11)
    const twelve = 'a'.repeat(12)
    expect(validatePasswordChange({ ...ok, next: eleven, confirm: eleven }).next).toMatch(/at least 12/)
    expect(validatePasswordChange({ ...ok, next: twelve, confirm: twelve }).next).toBeUndefined()
  })
  it('rejects a new password equal to the current one', () => {
    const e = validatePasswordChange({ current: 'same-fake-password', next: 'same-fake-password', confirm: 'same-fake-password' })
    expect(e.next).toMatch(/different/)
  })
  it('rejects a confirmation that does not match', () => {
    expect(validatePasswordChange({ ...ok, confirm: 'something-else-entirely' }).confirm).toMatch(/do not match/)
  })
  it('asks for the current password', () => {
    expect(validatePasswordChange({ ...ok, current: '' }).current).toMatch(/current password/)
  })
  it('never repeats what was typed, and uses no exclamation marks or emoji', () => {
    const e = validatePasswordChange({ current: 'secret-A', next: 'secret-B', confirm: 'secret-C' })
    const all = Object.values(e).join(' ')
    expect(all).not.toMatch(/secret-/)
    expect(all).not.toContain('!')
    expect(all).toMatch(/^[\x20-\x7E]*$/)
    expect(WRONG_CURRENT).toBe('Current password is incorrect.')
  })
})

describe('lockout after repeated wrong current passwords', () => {
  const t0 = 1_000_000

  it('is not locked before the fifth failure', () => {
    let l = noLockout
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      l = recordFailure(l, t0)
      expect(isLocked(l, t0)).toBe(false)
    }
    expect(l.fails).toBe(MAX_ATTEMPTS - 1)
  })
  it('locks for 15 minutes on the fifth failure, and counts the minutes down', () => {
    let l = noLockout
    for (let i = 0; i < MAX_ATTEMPTS; i++) l = recordFailure(l, t0)
    expect(isLocked(l, t0)).toBe(true)
    expect(l.lockedUntil).toBe(t0 + LOCK_MS)
    expect(LOCK_MS).toBe(15 * 60 * 1000)
    expect(minutesLeft(l, t0)).toBe(15)
    expect(minutesLeft(l, t0 + 14 * 60_000 + 1)).toBe(1)
    expect(isLocked(l, t0 + LOCK_MS - 1)).toBe(true)
  })
  it('unlocks once the time has passed and starts counting again', () => {
    let l = noLockout
    for (let i = 0; i < MAX_ATTEMPTS; i++) l = recordFailure(l, t0)
    expect(isLocked(l, t0 + LOCK_MS)).toBe(false)
    const again = recordFailure(l, t0 + LOCK_MS + 1)
    expect(again).toEqual({ fails: 1, lockedUntil: null })
  })
  it('a correct current password clears the count', () => {
    expect(recordSuccess()).toEqual(noLockout)
  })
})

describe('lockout storage', () => {
  it('round-trips through a session store and survives a bad value', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    saveLockout({ fails: 3, lockedUntil: null }, store)
    expect(loadLockout(store)).toEqual({ fails: 3, lockedUntil: null })
    store.setItem('odz.password-lockout', 'not json')
    expect(loadLockout(store)).toEqual(noLockout)
    store.setItem('odz.password-lockout', JSON.stringify({ fails: -4, lockedUntil: 'x' }))
    expect(loadLockout(store)).toEqual(noLockout)
  })
  it('works with no storage at all', () => {
    expect(loadLockout(undefined)).toEqual(noLockout)
    expect(() => saveLockout({ fails: 1, lockedUntil: null }, undefined)).not.toThrow()
  })
})
