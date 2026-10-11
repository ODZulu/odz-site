import { Link, Navigate } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Chip, Panel, Table } from '../components'
import { buttonClass } from '../components/Button'
import { groupBySlug, groupByType, listDocuments, type DocStatus } from '../lib/documents'
import { formatPlainDate } from '../lib/time'
import { useLoad } from '../lib/useLoad'

export function StatusChip({ status, published }: { status: DocStatus; published: boolean }) {
  if (status === 'ratified') return <Chip variant="go">RATIFIED</Chip>
  if (status === 'superseded') return <Chip variant="plain">SUPERSEDED</Chip>
  return <Chip variant="pending">{published ? 'DRAFT' : 'DRAFT, HIDDEN'}</Chip>
}

/** Members-only governance documents, grouped by type. Drafts show only to publishers (RLS). */
export default function Documents() {
  const { can } = useAuth()
  const list = useLoad(listDocuments)
  if (!can('read_documents') && !can('publish_documents')) return <Navigate to="/hq" replace />

  const types = groupByType(groupBySlug(list.data ?? []))

  return (
    <>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">Documents</h1>
        {can('publish_documents') && (
          <Link to="/documents/new" className={buttonClass('primary', true)}>
            New document
          </Link>
        )}
      </div>
      {list.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : list.failed ? (
        <p role="alert">Could not load the documents.</p>
      ) : types.length === 0 ? (
        <p className="odz-muted">No documents yet.</p>
      ) : (
        <div className="odz-stack">
          {types.map((t) => (
            <Panel key={t.type} title={t.type}>
              <Table
                rows={t.groups}
                rowKey={(g) => g.slug}
                columns={[
                  { header: 'Title', kind: 'cs', render: (g) => <Link to={`/documents/${g.slug}`}>{g.current.title}</Link> },
                  { header: 'Version', render: (g) => g.current.version },
                  { header: 'Effective', render: (g) => (g.current.effective_date ? formatPlainDate(g.current.effective_date) : '-') },
                  { header: 'Status', kind: 'status', render: (g) => <StatusChip status={g.current.status} published={g.current.published} /> },
                ]}
              />
            </Panel>
          ))}
        </div>
      )}
    </>
  )
}
