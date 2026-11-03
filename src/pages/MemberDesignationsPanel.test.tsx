import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Designation, MemberDesignation } from '../lib/designations'
import { MemberDesignationsPanel } from './MemberDesignationsPanel'

vi.mock('../lib/supabase', () => ({ supabase: null }))

const catalog: Designation[] = [
  { id: 'd1', name: 'Treasurer', description: '', capability_key: 'manage_treasury', office_seat: true, max_holders: 1 },
  { id: 'd2', name: 'Shop Manager', description: '', capability_key: 'manage_shop', office_seat: false, max_holders: 1 },
]
const assignments: MemberDesignation[] = [{ profile_id: 'p1', designation_id: 'd1' }]

const render = (p: Partial<Parameters<typeof MemberDesignationsPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <MemberDesignationsPanel profileId="p1" catalog={catalog} assignments={assignments} canEdit={false} onChange={() => {}} {...p} />,
  )

describe('MemberDesignationsPanel', () => {
  it('shows the badges a member holds', () => {
    expect(render()).toContain('Treasurer')
  })

  it('says when nobody is held', () => {
    expect(render({ assignments: [] })).toContain('No designations held.')
  })

  it('offers no controls without edit_roster', () => {
    const html = render()
    expect(html).not.toContain('Revoke')
    expect(html).not.toContain('Assign')
  })

  it('offers revoke on a held designation and assign for the rest, with edit_roster', () => {
    const html = render({ canEdit: true })
    expect(html).toContain('Revoke')
    expect(html).toContain('Assign')
    expect(html).toContain('Shop Manager')
  })

  it('offers no assign picker once every designation is already held', () => {
    const html = render({ canEdit: true, assignments: [{ profile_id: 'p1', designation_id: 'd1' }, { profile_id: 'p1', designation_id: 'd2' }] })
    expect(html).not.toContain('Assign a designation')
  })
})
