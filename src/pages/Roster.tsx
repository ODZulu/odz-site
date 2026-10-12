import { useState } from 'react'
import { Link } from 'react-router'
import { Field, Panel, Table, TierMark } from '../components'
import { filterRoster, sortRoster, type RosterMember } from '../lib/roster'
import { supabase } from '../lib/supabase'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'

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
  const [query, setQuery] = useState('')
  const rows = filterRoster(roster.data ?? [], query)

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
              { header: 'Role', render: (r) => r.role_note ?? '' },
              { header: 'Joined', render: (r) => (r.joined_at ? formatStampPhoenix(r.joined_at).slice(0, 7) : '') },
            ]}
          />
        )}
      </Panel>
    </>
  )
}
