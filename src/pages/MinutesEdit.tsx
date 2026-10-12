import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, ConfirmAction, Field, Panel, Select, Textarea } from '../components'
import { ACCEPT, formatSize } from '../lib/files'
import {
  deleteMinutes,
  getMinutes,
  readTextFile,
  removeMinutesFile,
  saveMinutes,
  uploadMinutesFile,
  validateMinutes,
  type MinutesErrors,
  type MinutesInput,
} from '../lib/minutes'
import { useLoad } from '../lib/useLoad'

const blank: MinutesInput = { title: '', meeting_date: '', body_md: '', status: 'draft' }

/** /minutes/new and /minutes/:id/edit. New minutes are saved first; files attach to a saved record. */
export default function MinutesEdit() {
  const { id } = useParams()
  const creating = !id
  const { can } = useAuth()
  const navigate = useNavigate()
  const existing = useLoad(() => (id ? getMinutes(id) : Promise.resolve(null)), [id])
  const [v, setV] = useState<MinutesInput>(blank)
  const [errors, setErrors] = useState<MinutesErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const m = existing.data
    if (m) setV({ title: m.title, meeting_date: m.meeting_date, body_md: m.body_md ?? '', status: m.status })
  }, [existing.data])

  if (!can('write_minutes')) return <Navigate to="/minutes" replace />

  async function save(e: FormEvent) {
    e.preventDefault()
    const found = validateMinutes(v)
    setErrors(found)
    setMessage(null)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    try {
      const savedId = await saveMinutes(id ?? null, v)
      if (creating) navigate(`/minutes/${savedId}/edit`, { replace: true })
      else {
        setMessage('Saved.')
        await existing.reload()
      }
    } catch {
      setMessage('Could not save.')
    }
    setBusy(false)
  }

  async function upload(files: FileList | null) {
    if (!files || !id) return
    setMessage(null)
    let count = existing.data?.files.length ?? 0
    for (const file of Array.from(files)) {
      const res = await uploadMinutesFile(id, file, count)
      if (!res.ok) {
        setMessage(`${file.name}: ${res.reason}`)
        break
      }
      count += 1
    }
    if (fileInput.current) fileInput.current.value = ''
    await existing.reload()
  }

  async function importBody(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    const res = await readTextFile(file)
    if (importInput.current) importInput.current.value = ''
    if (!res.ok) return setMessage(res.reason)
    setV((cur) => ({ ...cur, body_md: res.text }))
    setMessage('Imported into the notes. Review it, then save.')
  }

  const files = existing.data?.files ?? []

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/minutes">Minutes</Link>
      </p>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        {creating ? 'New minutes' : 'Edit minutes'}
      </h1>
      <div className="odz-stack">
        <Panel title="Details">
          <form onSubmit={save} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Title" maxLength={160} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} error={errors.title} />
            <Field label="Meeting date" type="date" value={v.meeting_date} onChange={(e) => setV({ ...v, meeting_date: e.target.value })} error={errors.meeting_date} />
            <Textarea
              label="Notes (markdown)"
              value={v.body_md}
              onChange={(e) => setV({ ...v, body_md: e.target.value })}
              error={errors.body_md}
              hint="Plain markdown. No images or raw HTML."
              style={{ minHeight: '14rem' }}
            />
            <div>
              <label className="odz-label" htmlFor="import-body">
                Import a TXT or MD file as the notes
              </label>
              <input id="import-body" ref={importInput} type="file" accept=".txt,.md" onChange={(e) => void importBody(e.target.files)} className="odz-input" />
            </div>
            <Select
              label="State"
              value={v.status}
              onChange={(e) => setV({ ...v, status: e.target.value as MinutesInput['status'] })}
              options={[
                { value: 'draft', label: 'Draft (only writers see it)' },
                { value: 'published', label: 'Published (members can read it)' },
              ]}
            />
            {message && <p role="status">{message}</p>}
            <div className="odz-row">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving' : 'Save'}
              </Button>
              {!creating && (
                <ConfirmAction
                  label="Delete"
                  confirmLabel="Confirm delete"
                  onConfirm={async () => {
                    await deleteMinutes(id!)
                    navigate('/minutes', { replace: true })
                  }}
                />
              )}
            </div>
          </form>
        </Panel>

        {!creating && (
          <Panel title="Files">
            <p className="odz-muted" style={{ marginBottom: '0.75rem' }}>
              PDF, TXT, MD or DOCX, up to 10 MB each. The contents are checked, not just the name.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, marginBottom: '1rem' }} className="odz-stack">
              {files.map((f) => (
                <li key={f.id} className="odz-row">
                  <span>{f.filename}</span>
                  <span className="odz-muted">{formatSize(f.size_bytes)}</span>
                  <ConfirmAction label="Remove" confirmLabel="Confirm remove" onConfirm={async () => { await removeMinutesFile(f); await existing.reload() }} />
                </li>
              ))}
            </ul>
            <label className="odz-label" htmlFor="upload-files">
              Add files
            </label>
            <input id="upload-files" ref={fileInput} type="file" multiple accept={ACCEPT} onChange={(e) => void upload(e.target.files)} className="odz-input" />
          </Panel>
        )}
      </div>
    </>
  )
}
