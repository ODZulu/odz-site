import { useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, KeyValue, Panel } from '../components'
import { buttonClass } from '../components/Button'
import { getDocument, groupBySlug, listDocuments } from '../lib/documents'
import { Markdown, markdownHeadings } from '../lib/markdown'
import { formatPlainDate } from '../lib/time'
import { useLoad } from '../lib/useLoad'
import { StatusChip } from './Documents'

/** One document: the ratified version by default, with a table of contents and a previous-versions toggle. */
export default function DocumentDetail() {
  const { slug = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const list = useLoad(listDocuments)
  const [showPrevious, setShowPrevious] = useState(false)

  const group = groupBySlug((list.data ?? []).filter((d) => d.slug === slug))[0]
  const wanted = params.get('v')
  const chosen = group && wanted ? [group.current, ...group.previous].find((d) => d.version === wanted) ?? group.current : group?.current
  const doc = useLoad(() => (chosen ? getDocument(chosen.id) : Promise.resolve(null)), [chosen?.id])

  if (!can('read_documents') && !can('publish_documents')) return <Navigate to="/hq" replace />
  if (list.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  if (list.failed || !group || !chosen) {
    return (
      <>
        <h1 className="odz-title">Not found</h1>
        <p>
          <Link to="/documents">Back to the documents</Link>
        </p>
      </>
    )
  }

  const body = doc.data?.body_md ?? ''
  const toc = markdownHeadings(body)

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }} className="odz-noprint">
        <Link to="/documents">Documents</Link>
      </p>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">{chosen.title}</h1>
        <span className="odz-row odz-noprint">
          <Button small variant="sec" onClick={() => window.print()}>
            Print
          </Button>
          {can('publish_documents') && (
            <Link to={`/documents/edit/${chosen.id}`} className={buttonClass('sec', true)}>
              Edit
            </Link>
          )}
        </span>
      </div>

      <div className="odz-stack">
        <Panel title="Version" action={<StatusChip status={chosen.status} published={chosen.published} />}>
          <KeyValue
            items={[
              ['Type', chosen.doc_type],
              ['Version', chosen.version],
              ['Effective', chosen.effective_date ? formatPlainDate(chosen.effective_date) : '-'],
            ]}
          />
          {chosen.status === 'superseded' && <p className="odz-muted" style={{ marginTop: '0.75rem' }}>This version has been superseded.</p>}
        </Panel>

        {toc.length > 1 && (
          <Panel title="Contents">
            <ol style={{ paddingLeft: '1.25rem' }}>
              {toc.map((h) => (
                <li key={h.id} style={{ marginLeft: `${Math.max(0, h.level - 1)}rem` }}>
                  <a href={`#${h.id}`}>{h.text}</a>
                </li>
              ))}
            </ol>
          </Panel>
        )}

        <Panel title="Text">
          {doc.loading ? (
            <p className="odz-muted" role="status">
              Loading
            </p>
          ) : doc.failed ? (
            <p role="alert">Could not load the text.</p>
          ) : (
            <Markdown source={body} />
          )}
        </Panel>

        {group.previous.length > 0 && (
          <Panel title="Previous versions">
            <div className="odz-noprint">
              <Button small variant="sec" onClick={() => setShowPrevious((s) => !s)}>
                {showPrevious ? 'Hide' : `Show ${group.previous.length}`}
              </Button>
            </div>
            {showPrevious && (
              <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.75rem' }} className="odz-stack">
                {[group.current, ...group.previous].map((d) => (
                  <li key={d.id} className="odz-row">
                    <button
                      type="button"
                      className="odz-btn odz-btn--ghost odz-btn--sm"
                      onClick={() => setParams({ v: d.version })}
                      aria-current={d.id === chosen.id ? 'true' : undefined}
                    >
                      {`v${d.version}`}
                    </button>
                    <StatusChip status={d.status} published={d.published} />
                    <span className="odz-muted">{d.effective_date ? formatPlainDate(d.effective_date) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>
    </>
  )
}
