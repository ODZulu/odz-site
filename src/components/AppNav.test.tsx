import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AppNav } from './AppNav'

// The nav reads the auth context, which imports the Supabase client; keep the test independent of local env files.
vi.mock('../lib/supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

describe('AppNav', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/hq']}>
      <AppNav />
    </MemoryRouter>,
  )

  it('renders only phase 1 tabs', () => {
    for (const label of ['HQ', 'ROSTER', 'CALENDAR']) expect(html).toContain(`>${label}<`)
    for (const label of ['MISSIONS', 'ATLAS', 'AAR']) expect(html).not.toContain(label)
    // The admin tab only appears for accounts with access.
    expect(html).not.toContain('ADMIN')
  })

  it('marks the active tab with aria-current', () => {
    expect(html).toMatch(/aria-current="page"[^>]*>HQ</)
  })
})
