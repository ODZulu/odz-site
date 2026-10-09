import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppNav } from './AppNav'

describe('AppNav', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/hq']}>
      <AppNav />
    </MemoryRouter>,
  )

  it('renders only phase 1 tabs', () => {
    for (const label of ['HQ', 'ROSTER', 'CALENDAR']) expect(html).toContain(`>${label}<`)
    for (const label of ['MISSIONS', 'ATLAS', 'AAR']) expect(html).not.toContain(label)
  })

  it('marks the active tab with aria-current', () => {
    expect(html).toMatch(/aria-current="page"[^>]*>HQ</)
  })
})
