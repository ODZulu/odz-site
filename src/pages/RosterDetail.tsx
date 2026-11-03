import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Chip, KeyValue, Panel, TierMark } from '../components'
import { designationNamesFor } from '../lib/designations'
import { findByCallsign } from '../lib/roster'
import type { TierOption } from '../lib/retire'
import type { SeatCounts } from '../lib/seats'
import type { ServiceEntry } from '../lib/service'
import { supabase } from '../lib/supabase'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'
import { MemberDesignationsPanel } from './MemberDesignationsPanel'
import { RemoveMemberPanel } from './RemoveMemberPanel'
import { loadDesignations, loadRetired, loadRoster } from './Roster'
import { RetireMemberPanel, UnretireMemberPanel } from './RetireMemberPanel'
import { ServiceRecordPanel } from './ServiceRecordPanel'

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
  const { can, isAdmin, session, tierName } = useAuth()
  const roster = useLoad(loadRoster)
  const retired = useLoad(loadRetired)
  const wanted = decodeURIComponent(callsign)
  const activeMember = findByCallsign(roster.data ?? [], wanted)
  const retiredMember = findByCallsign(retired.data ?? [], wanted)
  const member = activeMember ?? retiredMember
  const isRetired = !activeMember && !!retiredMember
  const showPrivate = can('view_member_private')
  // The database also enforces this (can_view_service_record); this just keeps the panel from
  // showing a misleading "nothing on file" to someone the record is genuinely hidden from.
  const canViewService =
    session?.user.id === member?.id || isAdmin || can('edit_roster') || tierName === 'Old Guard' || tierName === 'Command'

  const service = useLoad<{ doe: string | null; entries: ServiceEntry[] } | null>(async () => {
    if (!supabase || !member || !canViewService) return null
    const [rec, hist] = await Promise.all([
      supabase.from('service_records').select('doe').eq('profile_id', member.id).maybeSingle(),
      supabase
        .from('service_history')
        .select('id,profile_id,event_date,title,location,role,notes,source')
        .eq('profile_id', member.id),
    ])
    if (rec.error || hist.error) throw new Error('service')
    return { doe: (rec.data as { doe: string | null } | null)?.doe ?? null, entries: (hist.data ?? []) as ServiceEntry[] }
  }, [member?.id, canViewService])

  const designations = useLoad(loadDesignations)

  // Command / Admin (edit_roster) only: what the retire and return panels need. The database decides what is allowed.
  const canRetire = isAdmin || can('edit_roster')
  const target = useLoad<{ is_admin: boolean; status: string; tier_id: string | null } | null>(async () => {
    if (!supabase || !member || !canRetire) return null
    const { data, error } = await supabase.from('profiles').select('is_admin,status,tier_id').eq('id', member.id).maybeSingle()
    if (error || !data) throw new Error('target')
    return data as { is_admin: boolean; status: string; tier_id: string | null }
  }, [member?.id, canRetire, isRetired])
  const returnInfo = useLoad<{ tiers: TierOption[]; counts: SeatCounts | null } | null>(async () => {
    if (!supabase || !isRetired || !canRetire) return null
    const [t, c] = await Promise.all([
      supabase.from('tiers').select('id,name,rank,seat_group,role_based,entry_requires_tier_id'),
      supabase.rpc('seat_counts'),
    ])
    if (t.error) throw new Error('tiers')
    const counts = c.error ? null : (((c.data as SeatCounts[]) ?? [])[0] ?? null)
    return { tiers: (t.data ?? []) as TierOption[], counts }
  }, [member?.id, canRetire, isRetired])
  const reloadAll = () => {
    void roster.reload()
    void retired.reload()
    void designations.reload()
    void target.reload()
    void returnInfo.reload()
  }

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

  // Admin only: what the removal panel needs to decide what to offer (the database decides what is allowed).
  const removal = useLoad<{ is_admin: boolean; status: string; approvedAdmins: number } | null>(async () => {
    if (!supabase || !member || !isAdmin) return null
    const [row, admins] = await Promise.all([
      supabase.from('profiles').select('is_admin,status').eq('id', member.id).maybeSingle(),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_admin', true).eq('status', 'approved'),
    ])
    if (row.error || admins.error || !row.data) throw new Error('removal')
    return { ...(row.data as { is_admin: boolean; status: string }), approvedAdmins: admins.count ?? 0 }
  }, [member?.id, isAdmin])

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
              [isRetired ? 'Prior tier' : 'Tier', member.tier ? <TierMark tier={member.tier.name} /> : '-'],
              ...(isRetired ? ([['Status', <Chip key="status" variant="plain">RETIRED</Chip>]] as Array<[string, React.ReactNode]>) : []),
              ['Joined', member.joined_at ? formatStampPhoenix(member.joined_at).slice(0, 7) : '-'],
              ['Role', member.role_note ?? '-'],
            ]}
          />
        </Panel>
        <Panel title="Bio">
          <p style={{ whiteSpace: 'pre-wrap' }}>{member.bio ?? <span className="odz-muted">Nothing here yet.</span>}</p>
        </Panel>
        {designations.data && !isRetired && (
          <MemberDesignationsPanel
            profileId={member.id}
            catalog={designations.data.catalog}
            assignments={designations.data.assignments}
            canEdit={can('edit_roster')}
            onChange={() => void designations.reload()}
          />
        )}
        {canViewService && service.data && (
          <ServiceRecordPanel
            profileId={member.id}
            doe={service.data.doe}
            entries={service.data.entries}
            canEdit={can('edit_roster')}
            onChange={() => void service.reload()}
          />
        )}
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
        {canRetire && !isRetired && target.data && (
          <RetireMemberPanel
            callsign={member.callsign}
            target={{ id: member.id, is_admin: target.data.is_admin, status: target.data.status }}
            selfId={session?.user.id}
            canEdit={canRetire}
            isAdmin={isAdmin}
            designations={designationNamesFor(member.id, designations.data?.assignments ?? [], designations.data?.catalog ?? [])}
            onChange={reloadAll}
          />
        )}
        {canRetire && isRetired && target.data && returnInfo.data && (
          <UnretireMemberPanel
            callsign={member.callsign}
            profileId={member.id}
            currentTierId={target.data.tier_id}
            tierName={member.tier?.name ?? null}
            tiers={returnInfo.data.tiers}
            counts={returnInfo.data.counts}
            canEdit={canRetire}
            onChange={reloadAll}
          />
        )}
        {isAdmin && removal.data && (
          <RemoveMemberPanel
            callsign={member.callsign}
            target={{ id: member.id, is_admin: removal.data.is_admin, status: removal.data.status }}
            selfId={session?.user.id}
            approvedAdmins={removal.data.approvedAdmins}
          />
        )}
      </div>
    </>
  )
}
