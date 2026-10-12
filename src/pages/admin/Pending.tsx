import { useState } from 'react'
import { Chip, ConfirmAction, Panel, Table } from '../../components'
import { adminMessage } from '../../lib/admin'
import { formatStamp } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useLoad } from '../../lib/useLoad'

type PendingRow = {
  id: string
  callsign: string | null
  created_at: string
  setup_complete: boolean
  tier: { name: string } | null
}

/** Callsign only: private details are never listed here. */
export default function Pending() {
  const pending = useLoad(async () => {
    const { data, error } = await supabase!
      .from('profiles')
      .select('id,callsign,created_at,setup_complete,tier:tiers(name)')
      .eq('status', 'pending')
      .order('created_at')
    if (error) throw error
    return data as unknown as PendingRow[]
  })
  const [error, setError] = useState<string | null>(null)

  async function act(fn: 'approve_member' | 'reject_member', id: string) {
    if (!supabase) return
    setError(null)
    const { error: err } = await supabase.rpc(fn, { p_profile: id })
    if (err) setError(adminMessage(err))
    void pending.reload()
  }

  return (
    <Panel title="Pending approval" action={<Chip variant="pending">{String(pending.data?.length ?? 0)}</Chip>}>
      {error && (
        <p role="alert" style={{ color: 'var(--alert)', marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}
      {pending.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : pending.failed ? (
        <p role="alert">Could not load the queue.</p>
      ) : (pending.data ?? []).length === 0 ? (
        <p className="odz-muted">Nobody is waiting.</p>
      ) : (
        <Table
          rows={pending.data ?? []}
          rowKey={(r) => r.id}
          columns={[
            { header: 'Callsign', kind: 'cs', render: (r) => r.callsign ?? '(not set up yet)' },
            { header: 'Invited as', render: (r) => r.tier?.name ?? '-' },
            { header: 'Signed up', render: (r) => formatStamp(new Date(r.created_at)) },
            {
              header: 'Setup',
              kind: 'status',
              render: (r) => (r.setup_complete ? <Chip variant="go">DONE</Chip> : <Chip variant="pending">WAITING</Chip>),
            },
            {
              header: 'Action',
              render: (r) => (
                <span className="odz-row">
                  {r.setup_complete && (
                    <ConfirmAction label="Approve" variant="primary" onConfirm={() => act('approve_member', r.id)} />
                  )}
                  <ConfirmAction label="Reject" confirmLabel="Confirm reject" onConfirm={() => act('reject_member', r.id)} />
                </span>
              ),
            },
          ]}
        />
      )}
    </Panel>
  )
}
