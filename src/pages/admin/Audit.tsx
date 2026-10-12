import { useState } from 'react'
import { Button, Panel, Table } from '../../components'
import { formatStamp } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useLoad } from '../../lib/useLoad'

type AuditRow = { at: string; actor: string; kind: string; event: string; target: string; detail: string | null; total: number }

const PAGE = 25

/** Read-only. Private values never reach this screen: the feed carries field names only. */
export default function Audit() {
  const [page, setPage] = useState(0)
  const feed = useLoad(async () => {
    const { data, error } = await supabase!.rpc('list_audit', { p_limit: PAGE, p_offset: page * PAGE })
    if (error) throw error
    return data as AuditRow[]
  }, [page])
  const go = (next: number) => setPage(next)

  const rows = feed.data ?? []
  const total = rows[0] ? Number(rows[0].total) : 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <Panel title="Audit log">
      {feed.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : feed.failed ? (
        <p role="alert">Could not load the audit log.</p>
      ) : rows.length === 0 ? (
        <p className="odz-muted">Nothing recorded yet.</p>
      ) : (
        <Table
          rows={rows}
          rowKey={(r) => `${r.at}-${r.kind}-${r.event}-${r.target}-${r.detail ?? ''}`}
          columns={[
            { header: 'When', render: (r) => formatStamp(new Date(r.at)) },
            { header: 'Who', kind: 'cs', render: (r) => r.actor },
            { header: 'What', render: (r) => `${r.kind}: ${r.event}` },
            { header: 'Target', render: (r) => r.target },
            { header: 'Detail', render: (r) => r.detail ?? '' },
          ]}
        />
      )}
      <div className="odz-row" style={{ marginTop: '1rem' }}>
        <Button small variant="sec" disabled={page === 0} onClick={() => go(page - 1)}>
          Newer
        </Button>
        <span className="odz-label">{`Page ${page + 1} of ${pages}`}</span>
        <Button small variant="sec" disabled={page + 1 >= pages} onClick={() => go(page + 1)}>
          Older
        </Button>
      </div>
    </Panel>
  )
}
