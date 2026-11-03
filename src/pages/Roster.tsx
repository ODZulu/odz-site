import { useState } from 'react'
import { Link } from 'react-router'
import { DesignationBadges, Field, Panel, Select, SeatCounters, Table, TierMark } from '../components'
import { designationNamesFor, filterByDesignation, type Designation, type MemberDesignation } from '../lib/designations'
import { filterRoster, sortRoster, type RosterMember } from '../lib/roster'
import type { SeatCounts } from '../lib/seats'
import { supabase } from '../lib/supabase'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'

export async function loadDesignations(): Promise<{ catalog: Designation[]; assignments: MemberDesignation[] }> {
  const [catalog, assignments] = await Promise.all([
    supabase!.from('designations').select('id,name,description,capability_key,office_seat,max_holders').order('name'),
    supabase!.from('member_designations').select('profile_id,designation_id'),
  ])
  if (catalog.error || assignments.error) throw new Error('designations')
  return { catalog: catalog.data as Designation[], assignments: assignments.data as MemberDesignation[] }
}

/** Approved members only (RLS). The query asks for approved profiles with a callsign. */
export async function loadRoster(): Promise<RosterMember[]> {
  const { data, error } = await supabase!
    .from('profiles')
    .select('id,callsign,display_name,role_note,bio,joined_at,tier:tiers(name,rank)')
    .eq('status', 'approved')
    .not('callsign', 'is', null)
  if (error) throw new Error('roster')
  return sortRoster(data as unknown as RosterMember[])
}

export default function Roster() {
  const roster = useLoad(loadRoster)
  // Seat holders and roster managers only; anyone else gets a refusal and sees no panel.
  const seats = useLoad(async () => {
    const { data, error } = await supabase!.rpc('seat_counts')
    if (error) return null
    return (data as SeatCounts[])[0] ?? null
  })
  const [query, setQuery] = useState('')
  const [designationFilter, setDesignationFilter] = useState('')
  const designations = useLoad(loadDesignations)
  const catalog = designations.data?.catalog ?? []
  const assignments = designations.data?.assignments ?? []
  const rows = filterByDesignation(filterRoster(roster.data ?? [], query), assignments, designationFilter || null)

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Roster
      </h1>
      <div className="odz-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <Field
          label="Search by callsign"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {catalog.length > 0 && (
          <Select
            label="Filter by designation"
            value={designationFilter}
            onChange={(e) => setDesignationFilter(e.target.value)}
            options={[{ value: '', label: 'All designations' }, ...catalog.map((d) => ({ value: d.id, label: d.name }))]}
          />
        )}
      </div>
      {seats.data && <SeatCounters counts={seats.data} />}
      <Panel title="Members">
        {roster.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : roster.failed ? (
          <p role="alert">Could not load the roster.</p>
        ) : rows.length === 0 ? (
          <p className="odz-muted">{query || designationFilter ? 'No match.' : 'Nobody on the roster yet.'}</p>
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              {
                header: 'Callsign',
                kind: 'cs',
                render: (r) => <Link to={`/roster/${encodeURIComponent(r.callsign)}`}>{r.callsign}</Link>,
              },
              { header: 'Tier', render: (r) => (r.tier ? <TierMark tier={r.tier.name} /> : '-') },
              { header: 'Designations', render: (r) => <DesignationBadges names={designationNamesFor(r.id, assignments, catalog)} /> },
              { header: 'Role', render: (r) => r.role_note ?? '' },
              { header: 'Joined', render: (r) => (r.joined_at ? formatStampPhoenix(r.joined_at).slice(0, 7) : '') },
            ]}
          />
        )}
      </Panel>
    </>
  )
}
