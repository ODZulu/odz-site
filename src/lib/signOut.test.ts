import { describe, expect, it, vi } from 'vitest'
import { LOGIN_PATH, performSignOut, shouldReloadOnRestore } from './signOut'

const steps = (signOut: (o?: { scope: 'global' | 'local' | 'others' }) => Promise<{ error: unknown } | void>) => {
  const order: string[] = []
  return {
    order,
    clear: () => order.push('clear'),
    go: (p: string) => order.push(`go:${p}`),
    auth: { signOut: vi.fn(async (o?: { scope: 'global' | 'local' | 'others' }) => { order.push(`signOut:${o?.scope ?? 'global'}`); return signOut(o) }) },
  }
}

describe('performSignOut', () => {
  it('signs out, clears the cached profile, then goes to the login page', async () => {
    const s = steps(async () => ({ error: null }))
    await performSignOut(s)
    expect(s.order).toEqual(['signOut:global', 'clear', `go:${LOGIN_PATH}`])
    expect(LOGIN_PATH).toBe('/login')
  })

  it('still clears this device and goes to login when the server cannot be reached', async () => {
    const s = steps(async (o) => (o?.scope === 'local' ? { error: null } : { error: new Error('offline') }))
    await performSignOut(s)
    expect(s.order).toEqual(['signOut:global', 'signOut:local', 'clear', `go:${LOGIN_PATH}`])
  })

  it('does the same when the call throws', async () => {
    const s = steps(async (o) => {
      if (o?.scope === 'local') return { error: null }
      throw new Error('network')
    })
    await performSignOut(s)
    expect(s.order).toEqual(['signOut:global', 'signOut:local', 'clear', `go:${LOGIN_PATH}`])
  })

  it('goes to login even if the local fallback also throws', async () => {
    const s = steps(async () => {
      throw new Error('storage')
    })
    await performSignOut(s)
    expect(s.order.slice(-2)).toEqual(['clear', `go:${LOGIN_PATH}`])
  })

  it('redirects when there is no backend client at all', async () => {
    const order: string[] = []
    await performSignOut({ auth: undefined, clear: () => order.push('clear'), go: (p) => order.push(`go:${p}`) })
    expect(order).toEqual(['clear', 'go:/login'])
  })
})

describe('shouldReloadOnRestore', () => {
  it('reloads a cached page restored with no session', () => expect(shouldReloadOnRestore(true, false)).toBe(true))
  it('leaves a normal load alone', () => expect(shouldReloadOnRestore(false, false)).toBe(false))
  it('leaves a restored page alone while signed in', () => expect(shouldReloadOnRestore(true, true)).toBe(false))
})
