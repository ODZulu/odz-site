import { Link, Navigate } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Chip, Panel, Table } from '../components'
import { buttonClass } from '../components/Button'
import { listMinutes } from '../lib/minutes'
import { formatPlainDate } from '../lib/time'
import { useLoad } from '../lib/useLoad'

export default function Minutes() {
  const { can } = useAuth()
  const list = useLoad(listMinutes)
  if (!can('read_minutes') && !can('write_minutes')) return <Navigate to="/hq" replace />

  return (
    <>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">Minutes</h1>
        {can('write_minutes') && (
          <Link to="/minutes/new" className={buttonClass('primary', true)}>
            New minutes
          </Link>
        )}
      </div>
      <Panel title="Meetings">
        {list.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : list.failed ? (
          <p role="alert">Could not load the minutes.</p>
        ) : (list.data ?? []).length === 0 ? (
          <p className="odz-muted">No minutes yet.</p>
        ) : (
          <Table
            rows={list.data ?? []}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Date', render: (r) => formatPlainDate(r.meeting_date) },
              { header: 'Title', kind: 'cs', render: (r) => <Link to={`/minutes/${r.id}`}>{r.title}</Link> },
              { header: 'State', kind: 'status', render: (r) => (r.status === 'draft' ? <Chip variant="pending">DRAFT</Chip> : null) },
            ]}
          />
        )}
      </Panel>
    </>
  )
}
