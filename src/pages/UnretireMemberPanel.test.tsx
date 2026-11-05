import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UnretireMemberPanel } from './RetireMemberPanel'
import type { TierOption } from '../lib/retire'

vi.mock('../lib/supabase', () => ({ supabase: null }))

const tiers: TierOption[] = [{ id: 'tm', name: 'Member', rank: 3, seat_group: null, role_based: false, entry_requires_tier_id: null }]
const render = (p: Partial<Parameters<typeof UnretireMemberPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <UnretireMemberPanel callsign="Fake-Mem" profileId="p1" currentTierId="tm" tierName="Member" tiers={tiers} counts={null} canEdit onChange={() => {}} {...p} />,
  )

describe('UnretireMemberPanel', () => {
  it('with a tier on record, keeps the one-step return and no picker', () => {
    const html = render()
    expect(html).toContain('Return to roster')
    expect(html).toContain('Returning puts them back as Member')
    expect(html).not.toContain('Return as')
  })

  it('with no tier on record, asks for a tier up front instead of offering a return that would fail', () => {
    const html = render({ currentTierId: null, tierName: null })
    expect(html).toContain('Pick a tier to restore this member to')
    expect(html).toContain('Return as')
    expect(html).toContain('Return in this tier')
    expect(html).not.toContain('>Return to roster<')
  })
})
