import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { RemoveMemberPanel } from './RemoveMemberPanel'

vi.mock('../lib/supabase', () => ({ supabase: null }))

const render = (p: Partial<Parameters<typeof RemoveMemberPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RemoveMemberPanel
        callsign="Fake-Mem"
        target={{ id: 't1', is_admin: false, status: 'approved' }}
        selfId="me"
        approvedAdmins={2}
        {...p}
      />
    </MemoryRouter>,
  )

describe('RemoveMemberPanel', () => {
  it('asks for a reason and starts with the button disabled and no confirm step shown', () => {
    const html = render()
    expect(html).toContain('Reason (required)')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Remove member<\/button>/)
    expect(html).not.toContain('Confirm: remove')
  })

  it('says who can read the reason and what is kept', () => {
    const html = render()
    expect(html).toContain('only Admins can read')
    expect(html).toContain('Former member')
  })

  it('offers nothing for yourself', () => {
    const html = render({ target: { id: 'me', is_admin: true, status: 'approved' } })
    expect(html).toContain('You cannot remove yourself.')
    expect(html).not.toContain('<textarea')
  })

  it('offers nothing for the last Admin', () => {
    const html = render({ target: { id: 't1', is_admin: true, status: 'approved' }, approvedAdmins: 1 })
    expect(html).toContain('There must always be one Admin.')
    expect(html).not.toContain('<textarea')
  })

  it('offers nothing for a member who is already removed', () => {
    expect(render({ target: { id: 't1', is_admin: false, status: 'removed' } })).toContain('already removed')
  })
})
