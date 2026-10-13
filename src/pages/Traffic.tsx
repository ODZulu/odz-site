import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, ConfirmAction, Field, Panel, Textarea } from '../components'
import {
  archiveTraffic,
  authorLabel,
  loadTraffic,
  postTraffic,
  setTrafficPinned,
  TRAFFIC_BODY_MAX,
  TRAFFIC_TITLE_MAX,
  validateTraffic,
  type TrafficErrors,
} from '../lib/hq'
import { counter } from '../lib/roster'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'

const PAGE = 10

/** Full traffic list, paged. write_traffic holders can post, pin and archive (no hard delete). */
export default function Traffic() {
  const { can } = useAuth()
  const [page, setPage] = useState(0)
  const feed = useLoad(() => loadTraffic(PAGE, page * PAGE), [page])
  const [form, setForm] = useState({ title: '', body: '', pinned: false })
  const [errors, setErrors] = useState<TrafficErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const total = feed.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  async function post(e: FormEvent) {
    e.preventDefault()
    const found = validateTraffic(form)
    setErrors(found)
    setFailure(null)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    try {
      await postTraffic(form)
      setForm({ title: '', body: '', pinned: false })
      setPage(0)
      await feed.reload()
    } catch {
      setFailure('Could not post.')
    }
    setBusy(false)
  }

  async function run(fn: () => Promise<void>) {
    setFailure(null)
    try {
      await fn()
    } catch {
      setFailure('Could not change that post.')
    }
    await feed.reload()
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/hq">HQ</Link>
      </p>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Traffic
      </h1>
      <div className="odz-stack">
        {can('write_traffic') && (
          <Panel title="Post traffic">
            <form onSubmit={post} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <Field label="Title" maxLength={TRAFFIC_TITLE_MAX} hint={counter(form.title, TRAFFIC_TITLE_MAX)} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} error={errors.title} />
              <Textarea label="Message" maxLength={TRAFFIC_BODY_MAX} hint={`Plain text. ${counter(form.body, TRAFFIC_BODY_MAX)}`} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} error={errors.body} />
              <label className="odz-check">
                <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
                <span>Pin to the top</span>
              </label>
              <Button type="submit" disabled={busy}>
                {busy ? 'Posting' : 'Post'}
              </Button>
            </form>
          </Panel>
        )}

        {failure && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {failure}
          </p>
        )}

        <Panel title="Latest">
          {feed.loading ? (
            <p className="odz-muted" role="status">
              Loading
            </p>
          ) : feed.failed ? (
            <p role="alert">Could not load traffic.</p>
          ) : (feed.data?.posts ?? []).length === 0 ? (
            <p className="odz-muted">No traffic.</p>
          ) : (
            (feed.data?.posts ?? []).map((p) => (
              <article key={p.id} className="odz-post">
                <div className="odz-row">
                  {p.pinned && <Chip variant="accent">PINNED</Chip>}
                  <span className="odz-label">{`${authorLabel(p.author)} · ${formatStampPhoenix(p.created_at)}`}</span>
                </div>
                <h3 className="odz-post__title">{p.title}</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
                {can('write_traffic') && (
                  <div className="odz-row" style={{ marginTop: '0.5rem' }}>
                    <Button small variant="sec" onClick={() => void run(() => setTrafficPinned(p.id, !p.pinned))}>
                      {p.pinned ? 'Unpin' : 'Pin'}
                    </Button>
                    <ConfirmAction label="Archive" confirmLabel="Confirm archive" onConfirm={() => run(() => archiveTraffic(p.id))} />
                  </div>
                )}
              </article>
            ))
          )}
          <div className="odz-row" style={{ marginTop: '1rem' }}>
            <Button small variant="sec" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Newer
            </Button>
            <span className="odz-label">{`Page ${page + 1} of ${pages}`}</span>
            <Button small variant="sec" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
              Older
            </Button>
          </div>
        </Panel>
      </div>
    </>
  )
}
