import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ServiceEntry } from '../lib/service'
import { ServiceRecordPanel } from './ServiceRecordPanel'

vi.mock('../lib/supabase', () => ({ supabase: null }))

const entries: ServiceEntry[] = [
  { id: 'e1', profile_id: 'p1', event_date: '2015-06-01', title: 'Road to Rostov', location: 'Rostov', role: 'Driver', notes: null, source: 'manual' },
]

const render = (p: Partial<Parameters<typeof ServiceRecordPanel>[0]> = {}) =>
  renderToStaticMarkup(<ServiceRecordPanel profileId="p1" doe="2014-01-01" entries={entries} canEdit={false} onChange={() => {}} {...p} />)

describe('ServiceRecordPanel', () => {
  it('shows DOE, years of service and the mission count', () => {
    const html = render()
    expect(html).toContain('2014')
    expect(html).toContain('year')
    expect(html).toContain('1 mission')
  })

  it('flags a missing DOE instead of showing a date', () => {
    expect(render({ doe: null }).replace(/<[^>]+>/g, '')).toContain('DOE missing.')
  })

  it('lists history entries', () => {
    expect(render()).toContain('Road to Rostov')
  })

  it('says when there are none yet', () => {
    expect(render({ entries: [] })).toContain('No history entries yet.')
  })

  it('offers no edit controls without edit_roster', () => {
    const html = render()
    expect(html).not.toContain('Add entry')
    expect(html).not.toContain('Save DOE')
    expect(html).not.toContain('Delete')
  })

  it('offers DOE, add and per-entry controls with edit_roster', () => {
    const html = render({ canEdit: true })
    expect(html).toContain('Save DOE')
    expect(html).toContain('Add entry')
    expect(html).toContain('Delete')
    expect(html).toContain('Edit')
  })
})
