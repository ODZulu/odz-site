import { describe, expect, it } from 'vitest'
import { crumbs } from './nav'

describe('crumbs', () => {
  it('names the section and a known sub-page', () => {
    expect(crumbs('/hq')).toEqual(['HQ'])
    expect(crumbs('/admin/tiers')).toEqual(['Admin', 'Tiers'])
    expect(crumbs('/minutes/new')).toEqual(['Minutes', 'New'])
    expect(crumbs('/settings/notifications')).toEqual(['Settings', 'Notifications'])
  })
  it('never shows an id or a slug', () => {
    expect(crumbs('/roster/FAKE-1')).toEqual(['Roster'])
    expect(crumbs('/minutes/5b0e1c9e-0000-4000-8000-000000000000')).toEqual(['Minutes'])
    expect(crumbs('/documents/fake-slug')).toEqual(['Docs'])
  })
  it('has no trail for an unknown path', () => {
    expect(crumbs('/nowhere')).toEqual([])
    expect(crumbs('/')).toEqual([])
  })
})
