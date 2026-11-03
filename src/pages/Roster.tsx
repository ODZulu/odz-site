import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { DesignationBadges, Field, Panel, Select, SeatCounters, Table, TierMark } from '../components'
import { designationNamesFor, filterByDesignation, type Designation, type MemberDesignation } from '../lib/designations'
import { filterRoster, sortRoster, type RosterMember } from '../lib/roster'
import type { SeatCounts } from '../lib/seats'
import { yearsOfService } from '../lib/service'
import { supabase } from '../lib/supabase'
import { formatPlainDate, formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'

type SeniorityRow = { profile_id: string; doe: string | null }

/** DOE and mission count are a comparison tool for Old Guard/Command (Dax ruling: display only,
 * no computed rank); RLS returns nothing for anyone else, so this is skipped for everyone else. */
async function loadSeniority(): Promise<{ records: SeniorityRow[]; counts: Map<string, number> }> {
  const [rec, hist] = await Promise.all([
    supabase!.from('service_records').select('profile_id,doe'),
    supabase!.from('service_history').select('profile_id'),
  ])
  if (rec.error || hist.error) throw new Error('seniority')
  const counts = new Map<string, number>()
  for (const row of (hist.data ?? []) as Array<{ profile_id: string }>) {
    counts.set(row.profile_id, (counts.get(row.profile_id) ?? 0) + 1)
  }
  return { records: (rec.data ?? []) as SeniorityRow[], counts }
}

export async function loadDesignations(): Promise<{ catalog: Designation[]; assignments: MemberDesignation[] }> {
  const [catalog, assignments] = await Promise.all([
    supabase!.from('designations').select('id,name,description,capability_key,office_seat,max_holders').order('name'),
    supabase!.from('member_designations').select('profile_id,designation_id'),
  ])
  if (catalog.error || assignments.error) throw new Error('designations')
  return { catalog: catalog.data as Designation[], assignments: assignments.data as MemberDesignation[] }
}

/** Retired members (MVA-238): readable by approved members, listed apart from the active roster. */
export async function loadRetired(): Promise<RosterMember[]> {
  const { data, error } = await supabase!
    .from('profiles')
    .select('id,callsign,display_name,role_note,bio,joined_at,tier:tiers(name,rank)')
    .eq('status', 'retired')
    .not('callsign', 'is', null)
  if (error) throw new Error('retired')
  return sortRoster(data as unknown as RosterMember[])
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
  const { isAdmin, can, tierName } = useAuth()
  const canCompareSeniority = isAdmin || can('edit_roster') || tierName === 'Old Guard' || tierName === 'Command'
  const roster = useLoad(loadRoster)
  const retired = useLoad(loadRetired)
  // Seat holders and roster managers only; anyone else gets a refusal and sees no panel.
  const seats = useLoad(async () => {
    const { data, error } = await supabase!.rpc('seat_counts')
    if (error) return null
    return (data as SeatCounts[])[0] ?? null
  })
  const seniority = useLoad(async () => (canCompareSeniority ? loadSeniority() : null), [canCompareSeniority])
  const [query, setQuery] = useState('')
  const [designationFilter, setDesignationFilter] = useState('')
  const designations = useLoad(loadDesignations)
  const catalog = designations.data?.catalog ?? []
  const assignments = designations.data?.assignments ?? []
  const rows = filterByDesignation(filterRoster(roster.data ?? [], query), assignments, designationFilter || null)
  const doeFor = (profileId: string) => seniority.data?.records.find((r) => r.profile_id === profileId)?.doe ?? null

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
              ...(canCompareSeniority
                ? [
                    {
                      header: 'Seniority',
                      render: (r: RosterMember) => {
                        const doe = doeFor(r.id)
                        const years = yearsOfService(doe)
                        const missions = seniority.data?.counts.get(r.id) ?? 0
                        return doe ? (
                          <span>{`${formatPlainDate(doe)} · ${years}y · ${missions}`}</span>
                        ) : (
                          <span className="odz-muted">DOE missing</span>
                        )
                      },
                    },
                  ]
                : []),
              { header: 'Role', render: (r) => r.role_note ?? '' },
              { header: 'Joined', render: (r) => (r.joined_at ? formatStampPhoenix(r.joined_at).slice(0, 7) : '') },
            ]}
          />
        )}
      </Panel>
      {(retired.data ?? []).length > 0 && (
        <Panel title={`Retired (${retired.data?.length})`}>
          <Table
            rows={retired.data ?? []}
            rowKey={(r) => r.id}
            columns={[
              {
                header: 'Callsign',
                kind: 'cs',
                render: (r) => <Link to={`/roster/${encodeURIComponent(r.callsign)}`}>{r.callsign}</Link>,
              },
              { header: 'Was', render: (r) => (r.tier ? <TierMark tier={r.tier.name} /> : '-') },
            ]}
          />
        </Panel>
      )}
    </>
  )
}
