import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, KeyValue, Panel } from '../components'
import { buttonClass } from '../components/Button'
import { formatSize } from '../lib/files'
import { Markdown } from '../lib/markdown'
import { getMinutes, signedUrl, type MinutesFile } from '../lib/minutes'
import { formatPlainDate } from '../lib/time'
import { useLoad } from '../lib/useLoad'

export default function MinutesDetail() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const minutes = useLoad(() => getMinutes(id), [id])
  const [error, setError] = useState<string | null>(null)

  if (!can('read_minutes') && !can('write_minutes')) return <Navigate to="/hq" replace />

  async function download(f: MinutesFile) {
    setError(null)
    const url = await signedUrl(f)
    // Opened immediately: the link is good for one minute and is never stored or logged.
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    else setError('Could not open that file.')
  }

  if (minutes.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  const m = minutes.data
  if (minutes.failed || !m) {
    return (
      <>
        <h1 className="odz-title">Not found</h1>
        <p>
          <Link to="/minutes">Back to the minutes</Link>
        </p>
      </>
    )
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }} className="odz-noprint">
        <Link to="/minutes">Minutes</Link>
      </p>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">{m.title}</h1>
        {can('write_minutes') && (
          <Link to={`/minutes/${m.id}/edit`} className={`${buttonClass('sec', true)} odz-noprint`}>
            Edit
          </Link>
        )}
      </div>
      <div className="odz-stack">
        <Panel title="Meeting" action={m.status === 'draft' ? <Chip variant="pending">DRAFT</Chip> : undefined}>
          <KeyValue items={[['Date', formatPlainDate(m.meeting_date)]]} />
        </Panel>
        {m.body_md && (
          <Panel title="Notes">
            <Markdown source={m.body_md} />
          </Panel>
        )}
        {m.files.length > 0 && (
          <Panel title="Files">
            {error && (
              <p role="alert" style={{ color: 'var(--alert)', marginBottom: '0.5rem' }}>
                {error}
              </p>
            )}
            <ul style={{ listStyle: 'none', padding: 0 }} className="odz-stack">
              {m.files.map((f) => (
                <li key={f.id} className="odz-row">
                  <span>{f.filename}</span>
                  <span className="odz-muted">{formatSize(f.size_bytes)}</span>
                  <Button small variant="sec" onClick={() => void download(f)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  )
}
