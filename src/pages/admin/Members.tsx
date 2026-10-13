import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { Button, Chip, Field, Panel, Select, Table } from '../../components'
import { adminMessage } from '../../lib/admin'
import { supabase } from '../../lib/supabase'
import { crossesSupportLine, supportMoveBlock, TIER_NOTE_MAX, validateTierNote, type TierFlags } from '../../lib/tiers'
import { useLoad } from '../../lib/useLoad'
import RemovedMembers from './RemovedMembers'

type MemberRow = { id: string; callsign: string | null; status: string; is_admin: boolean; tier_id: string | null }
type TierRow = TierFlags & { rank: number }
type PendingMove = { id: string; callsign: string; to: TierRow; note: string }

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
    const { data, error } = await supabase!.from('tiers').select('id,name,rank,role_based,support_barred').order('rank')
    if (error) throw error
    return data as TierRow[]
  })
  const [error, setError] = useState<string | null>(null)
  const [move, setMove] = useState<PendingMove | null>(null)

  /**
   * A tier change that crosses the player/Support line needs a note and goes through
   * move_support_tier(); every other change is a plain update.
   */
  function pickTier(row: MemberRow, tierId: string) {
    const list = tiers.data ?? []
    const from = list.find((t) => t.id === row.tier_id)
    const to = list.find((t) => t.id === tierId)
    if (from && to && crossesSupportLine(from, to)) {
      const blocked = supportMoveBlock(from, to)
      if (blocked) return setError(blocked)
      setError(null)
      return setMove({ id: row.id, callsign: row.callsign ?? 'member', to, note: '' })
    }
    void change(row.id, { tier_id: tierId || null })
  }

  async function confirmMove() {
    if (!supabase || !move || validateTierNote(move.note)) return
    setError(null)
    const { error: err } = await supabase.rpc('move_support_tier', {
      p_profile: move.id,
      p_tier: move.to.id,
      p_note: move.note.trim(),
    })
    if (err) setError(adminMessage(err))
    else setMove(null)
    void members.reload()
  }

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
    <>
    <Panel title="Members">
      {error && (
        <p role="alert" style={{ color: 'var(--alert)', marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}
      {move && (
        <div className="odz-stack" style={{ marginBottom: '1rem' }}>
          <p>
            {`Move ${move.callsign} to ${move.to.name}. This is logged with your note.`}
          </p>
          <Field
            label="Note (required)"
            autoComplete="off"
            maxLength={TIER_NOTE_MAX}
            value={move.note}
            onChange={(e) => setMove({ ...move, note: e.target.value })}
          />
          <div className="odz-row">
            <Button disabled={validateTierNote(move.note) !== null} onClick={() => void confirmMove()}>
              {`Confirm: move ${move.callsign}`}
            </Button>
            <Button variant="ghost" onClick={() => setMove(null)}>
              Cancel
            </Button>
          </div>
        </div>
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
                  onChange={(e) => pickTier(r, e.target.value)}
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
    {isAdmin && <RemovedMembers />}
    </>
  )
}
