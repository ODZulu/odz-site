import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Field, Panel, SeatCounters, Table, TierMark } from '../components'
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
  // Seat holders and roster managers only; anyone else gets a refusal and sees no panel.
  const seats = useLoad(async () => {
    const { data, error } = await supabase!.rpc('seat_counts')
    if (error) return null
    return (data as SeatCounts[])[0] ?? null
  })
  const seniority = useLoad(async () => (canCompareSeniority ? loadSeniority() : null), [canCompareSeniority])
  const [query, setQuery] = useState('')
  const rows = filterRoster(roster.data ?? [], query)
  const doeFor = (profileId: string) => seniority.data?.records.find((r) => r.profile_id === profileId)?.doe ?? null

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Roster
      </h1>
      <div style={{ marginBottom: '1rem' }}>
        <Field
          label="Search by callsign"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
          <p className="odz-muted">{query ? 'No callsign matches.' : 'Nobody on the roster yet.'}</p>
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
    </>
  )
}
