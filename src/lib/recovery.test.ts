import { describe, expect, it } from 'vitest'
import { clearRecovery, hasRecovery, hasResetErrors, isRecoveryHash, markRecovery, NEUTRAL_RESET_MESSAGE, resetUrl, validateForgot, validateReset } from './recovery'
import { PASSWORD_MIN } from './validate'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

describe('validateForgot', () => {
  it('only checks the address is well formed', () => {
    expect(validateForgot('')).not.toBeNull()
    expect(validateForgot('not-an-email')).not.toBeNull()
    expect(validateForgot('fake@example.invalid')).toBeNull()
  })
})

describe('validateReset', () => {
  const ok = 'x'.repeat(PASSWORD_MIN)
  it('uses the signup length rule', () => {
    expect(validateReset('x'.repeat(PASSWORD_MIN - 1), 'x'.repeat(PASSWORD_MIN - 1)).password).toMatch(String(PASSWORD_MIN))
    expect(hasResetErrors(validateReset(ok, ok))).toBe(false)
  })
  it('requires the confirm field to match', () => {
    expect(validateReset(ok, ok + 'y').confirm).toBeDefined()
  })
})

describe('recovery marker', () => {
  it('is set, read and cleared per tab', () => {
    const s = memory()
    expect(hasRecovery(s)).toBe(false)
    markRecovery(s)
    expect(hasRecovery(s)).toBe(true)
    clearRecovery(s)
    expect(hasRecovery(s)).toBe(false)
  })
  it('is false when storage is unavailable', () => {
    expect(hasRecovery({ getItem: () => { throw new Error('denied') }, setItem: () => {}, removeItem: () => {} })).toBe(false)
  })
})

describe('messages', () => {
  it('the neutral message does not mention accounts existing or not', () => {
    expect(NEUTRAL_RESET_MESSAGE).toBe('If that address has an account, a reset link is on its way.')
  })
  it('builds the redirect from the origin', () => {
    expect(resetUrl('https://odzulu.com')).toBe('https://odzulu.com/reset-password')
  })
})

describe('isRecoveryHash', () => {
  it('recognises a recovery redirect fragment only', () => {
    expect(isRecoveryHash('#access_token=a&refresh_token=b&type=recovery')).toBe(true)
    expect(isRecoveryHash('#access_token=a&type=signup')).toBe(false)
    expect(isRecoveryHash('')).toBe(false)
  })
})
