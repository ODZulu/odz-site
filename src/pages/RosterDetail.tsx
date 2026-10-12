import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Chip, KeyValue, Panel, TierMark } from '../components'
import { findByCallsign } from '../lib/roster'
import { supabase } from '../lib/supabase'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'
import { loadRoster } from './Roster'

type PrivateRow = {
  legal_name: string
  dob: string
  phone: string | null
  allergies: string
  emergency_name: string
  emergency_relationship: string
  emergency_phone: string
}

/** Text is rendered as text (React escapes it): a bio with markup shows the markup, not its effect. */
export default function RosterDetail() {
  const { callsign = '' } = useParams()
  const { can } = useAuth()
  const roster = useLoad(loadRoster)
  const member = findByCallsign(roster.data ?? [], decodeURIComponent(callsign))
  const showPrivate = can('view_member_private')

  const priv = useLoad<PrivateRow | null>(async () => {
    if (!supabase || !member || !showPrivate) return null
    const { data, error } = await supabase
      .from('member_private')
      .select('legal_name,dob,phone,allergies,emergency_name,emergency_relationship,emergency_phone')
      .eq('profile_id', member.id)
      .maybeSingle()
    if (error) throw new Error('private')
    return (data as PrivateRow | null) ?? null
  }, [member?.id, showPrivate])

  if (roster.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  if (roster.failed) return <p role="alert">Could not load the roster.</p>
  if (!member) {
    return (
      <>
        <h1 className="odz-title">Not found</h1>
        <p>
          <Link to="/roster">Back to the roster</Link>
        </p>
      </>
    )
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/roster">Roster</Link>
      </p>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        {member.callsign}
      </h1>
      <div className="odz-stack">
        <Panel title="Profile">
          <KeyValue
            items={[
              ['Display name', member.display_name ?? '-'],
              ['Tier', member.tier ? <TierMark tier={member.tier.name} /> : '-'],
              ['Joined', member.joined_at ? formatStampPhoenix(member.joined_at).slice(0, 7) : '-'],
              ['Role', member.role_note ?? '-'],
            ]}
          />
        </Panel>
        <Panel title="Bio">
          <p style={{ whiteSpace: 'pre-wrap' }}>{member.bio ?? <span className="odz-muted">Nothing here yet.</span>}</p>
        </Panel>
        {showPrivate && (
          <Panel title="Private details" action={<Chip variant="accent">COMMAND-ONLY</Chip>}>
            {priv.loading ? (
              <p className="odz-muted" role="status">
                Loading
              </p>
            ) : priv.failed ? (
              <p role="alert">Could not load.</p>
            ) : priv.data ? (
              <KeyValue
                items={[
                  ['Legal name', priv.data.legal_name],
                  ['Date of birth', priv.data.dob],
                  ['Mobile', priv.data.phone ?? '-'],
                  ['Allergies', priv.data.allergies],
                  ['Emergency contact', `${priv.data.emergency_name} (${priv.data.emergency_relationship})`],
                  ['Emergency phone', priv.data.emergency_phone],
                ]}
              />
            ) : (
              <p className="odz-muted">No private details on file.</p>
            )}
          </Panel>
        )}
      </div>
    </>
  )
}
