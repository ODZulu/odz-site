import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { Chip, Panel, Select, Table } from '../../components'
import { adminMessage } from '../../lib/admin'
import { supabase } from '../../lib/supabase'
import { useLoad } from '../../lib/useLoad'

type MemberRow = { id: string; callsign: string | null; status: string; is_admin: boolean; tier_id: string | null }
type TierRow = { id: string; name: string; rank: number }

/**
 * Set a member's tier and status, and the admin flag. The database applies the tier entry and
 * release rules, the self-change rules and the last-admin rule; this screen just reports them.
 */
export default function Members() {
  const { session, isAdmin, can } = useAuth()
const myId = session?.user.id
  const members = useLoad(async () => {
    const { data, error } = await supabase!
      .from('profiles')
      .select('id,callsign,status,is_admin,tier_id')
      .in('status', ['approved', 'suspended'])
      .order('callsign')
    if (error) throw error
    return data as MemberRow[]
  })
  const tiers = useLoad(async () => {
    const { data, error } = await supabase!.from('tiers').select('id,name,rank').order('rank')
    if (error) throw error
    return data as TierRow[]
  })
  const [error, setError] = useState<string | null>(null)

  async function change(id: string, patch: Partial<Pick<MemberRow, 'tier_id' | 'status' | 'is_admin'>>) {
    if (!supabase) return
    setError(null)
    const { error: err } = await supabase.from('profiles').update(patch).eq('id', id)
    if (err) setError(adminMessage(err))
    void members.reload()
  }

  const tierOptions = [{ value: '', label: '(none)' }, ...(tiers.data ?? []).map((t) => ({ value: t.id, label: t.name }))]
  const canTier = can('edit_roster')
  const canStatus = can('approve_members')

  return (
    <Panel title="Members">
      {error && (
        <p role="alert" style={{ color: 'var(--alert)', marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}
      {members.loading || tiers.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : members.failed ? (
        <p role="alert">Could not load members.</p>
      ) : (
        <Table
          rows={members.data ?? []}
          rowKey={(r) => r.id}
          columns={[
            { header: 'Callsign', kind: 'cs', render: (r) => r.callsign ?? '-' },
            {
              header: 'Tier',
              render: (r) => (
                <Select
                  label={`Tier for ${r.callsign ?? 'member'}`}
                  hideLabel
                  value={r.tier_id ?? ''}
                  disabled={!canTier || r.id === myId}
                  onChange={(e) => void change(r.id, { tier_id: e.target.value || null })}
                  options={tierOptions}
                />
              ),
            },
            {
              header: 'Status',
              kind: 'status',
              render: (r) =>
                canStatus ? (
                  <Select
                    label={`Status for ${r.callsign ?? 'member'}`}
                    hideLabel
                    value={r.status}
                    onChange={(e) => void change(r.id, { status: e.target.value })}
                    options={[
                      { value: 'approved', label: 'Approved' },
                      { value: 'suspended', label: 'Suspended' },
                    ]}
                  />
                ) : (
                  <Chip variant={r.status === 'approved' ? 'go' : 'alert'}>{r.status.toUpperCase()}</Chip>
                ),
            },
            {
              header: 'Admin',
              render: (r) =>
                isAdmin ? (
                  <label className="odz-check">
                    <input
                      type="checkbox"
                      checked={r.is_admin}
                      onChange={(e) => void change(r.id, { is_admin: e.target.checked })}
                    />
                    <span>Admin</span>
                  </label>
                ) : r.is_admin ? (
                  <Chip variant="accent">ADMIN</Chip>
                ) : null,
            },
          ]}
        />
      )}
    </Panel>
  )
}
