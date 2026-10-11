import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import Landing from './Landing'
import Login from './Login'

// Pages render without a Supabase client; keeps the test independent of local env files.
vi.mock('../lib/supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// Invite-only signup must not be visible to the public (Dax, 2026-10-10; MVA-199).
describe('no public signup UI', () => {
  it('the landing page shows login only', () => {
    const html = render(<Landing />).toLowerCase()
    expect(html).toContain('sign in')
    for (const word of ['join', 'sign up', 'signup', 'register', 'request access', 'apply', 'invite']) {
      expect(html).not.toContain(word)
    }
  })

  it('the login page has no signup or forgot-password link', () => {
    // Not configured in tests, so it renders the notice; the page text itself is what matters.
    const html = render(<Login />).toLowerCase()
    for (const word of ['join', 'sign up', 'signup', 'register', 'request access', 'forgot', 'invite']) {
      expect(html).not.toContain(word)
    }
  })

  it('nothing in the source links to /join except its own route', () => {
    const files = walk('src')
      .map((p) => p.split('\\').join('/'))
      .filter((p) => /\.(tsx?)$/.test(p) && !p.endsWith('.test.tsx') && !p.endsWith('.test.ts'))
      .filter((p) => !['src/App.tsx', 'src/pages/Join.tsx'].includes(p))
    const offenders = files.filter((p) => /['"`]\/join/.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })
})
