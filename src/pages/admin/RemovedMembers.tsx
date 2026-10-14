import { useState } from 'react'
import { Button, ConfirmAction, Field, Panel, Table, Textarea } from '../../components'
import { adminMessage } from '../../lib/admin'
import { formatStamp } from '../../lib/format'
import { confirmsCallsign, REASON_MAX, validateReason } from '../../lib/removal'
import { counter } from '../../lib/roster'
import { supabase } from '../../lib/supabase'
import { useLoad } from '../../lib/useLoad'

type RemovedRow = { id: string; callsign: string | null; removed_at: string | null }

/**
 * Admin only. Removed members, and the separate permanent delete for accounts made in error or
 * privacy requests. Delete asks for a reason, the callsign typed back, and a confirm step. Their
 * content stays, shown as "Former member"; nothing here can bring a member back (that is a fresh invite).
 */
export default function RemovedMembers() {
  const removed = useLoad(async () => {
    const { data, error } = await supabase!
      .from('profiles')
      .select('id,callsign,removed_at')
      .eq('status', 'removed')
      .order('removed_at', { ascending: false })
    if (error) throw error
    return data as RemovedRow[]
  })
  const [open, setOpen] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  const rows = removed.data ?? []
  const target = rows.find((r) => r.id === open) ?? null
  const ready = target !== null && validateReason(reason) === null && confirmsCallsign(typed, target.callsign)

  function close() {
    setOpen(null)
    setReason('')
    setTyped('')
  }

  async function hardDelete() {
    if (!supabase || !target || !ready) return
    setError(null)
    const { error: err } = await supabase.rpc('delete_removed_member', { p_profile: target.id, p_reason: reason.trim() })
    if (err) {
      setError(adminMessage(err))
      return
    }
    close()
    void removed.reload()
  }

  return (
    <Panel title="Removed members">
      {error && (
        <p role="alert" style={{ color: 'var(--alert)', marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}
      {removed.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : removed.failed ? (
        <p role="alert">Could not load removed members.</p>
      ) : rows.length === 0 ? (
        <p className="odz-muted">Nobody has been removed.</p>
      ) : (
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            { header: 'Callsign', kind: 'cs', render: (r) => r.callsign ?? '-' },
            { header: 'Removed', render: (r) => (r.removed_at ? formatStamp(new Date(r.removed_at)) : '-') },
            {
              header: 'Delete for good',
              render: (r) => (
                <Button small variant="sec" onClick={() => (setOpen(r.id), setReason(''), setTyped(''), setError(null))}>
                  {`Delete ${r.callsign ?? 'member'}...`}
                </Button>
              ),
            },
          ]}
        />
      )}
      {target && (
        <div className="odz-stack" style={{ marginTop: '1rem' }} role="group" aria-label="Delete a removed member for good">
          <p>
            {`Deleting ${target.callsign ?? 'this member'} for good removes the account and their roster entry. It cannot be undone. Use it for accounts made in error and privacy requests. The audit log keeps the callsign, your name and the reason.`}
          </p>
          <Textarea
            label="Reason (required)"
            value={reason}
            maxLength={REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            hint={counter(reason, REASON_MAX)}
          />
          <Field
            label="Type the callsign to confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="odz-row">
            <ConfirmAction
              label="Delete for good"
              confirmLabel={`Confirm: delete ${target.callsign ?? 'member'}`}
              small={false}
              disabled={!ready}
              onConfirm={hardDelete}
            />
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Panel>
  )
}
