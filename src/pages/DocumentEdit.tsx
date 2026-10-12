import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, ConfirmAction, Field, Panel, Select, Textarea } from '../components'
import {
  deleteDocument,
  DOC_TYPES,
  getDocument,
  saveDocument,
  slugify,
  validateDocument,
  type DocErrors,
  type DocInput,
} from '../lib/documents'
import { useLoad } from '../lib/useLoad'

const blank: DocInput = {
  slug: '',
  title: '',
  doc_type: 'Other',
  version: '1.0',
  status: 'draft',
  effective_date: '',
  body_md: '',
  published: false,
}

/** /documents/new and /documents/edit/:id. Publishers only. The text is typed or pasted here; it never lives in the repo. */
export default function DocumentEdit() {
  const { id } = useParams()
  const creating = !id
  const { can } = useAuth()
  const navigate = useNavigate()
  const existing = useLoad(() => (id ? getDocument(id) : Promise.resolve(null)), [id])
  const [v, setV] = useState<DocInput>(blank)
  const [slugTouched, setSlugTouched] = useState(false)
  const [errors, setErrors] = useState<DocErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const d = existing.data
    if (d) {
      setV({
        slug: d.slug,
        title: d.title,
        doc_type: d.doc_type,
        version: d.version,
        status: d.status,
        effective_date: d.effective_date ?? '',
        body_md: d.body_md,
        published: d.published,
      })
    }
  }, [existing.data])

  if (!can('publish_documents')) return <Navigate to="/documents" replace />

  async function save(e: FormEvent) {
    e.preventDefault()
    const found = validateDocument(v, creating)
    setErrors(found)
    setMessage(null)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    try {
      const savedId = await saveDocument(id ?? null, v)
      if (creating) navigate(`/documents/edit/${savedId}`, { replace: true })
      else {
        setMessage('Saved.')
        await existing.reload()
      }
    } catch {
      // A duplicate slug and version, or a refused change. No detail is shown.
      setMessage('Could not save. Check that this slug and version are not already used.')
    }
    setBusy(false)
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/documents">Documents</Link>
      </p>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        {creating ? 'New document' : 'Edit document'}
      </h1>
      <Panel title="Document">
        <form onSubmit={save} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Field
            label="Title"
            maxLength={160}
            value={v.title}
            onChange={(e) => setV({ ...v, title: e.target.value, slug: creating && !slugTouched ? slugify(e.target.value) : v.slug })}
            error={errors.title}
          />
          <Field
            label="Slug"
            value={v.slug}
            disabled={!creating}
            onChange={(e) => {
              setSlugTouched(true)
              setV({ ...v, slug: e.target.value })
            }}
            error={errors.slug}
            hint="The address of the document. All versions of one document share it. Fixed after creation."
          />
          <Select label="Type" value={v.doc_type} onChange={(e) => setV({ ...v, doc_type: e.target.value as DocInput['doc_type'] })} options={DOC_TYPES.map((t) => ({ value: t, label: t }))} />
          <Field label="Version" value={v.version} onChange={(e) => setV({ ...v, version: e.target.value })} error={errors.version} hint="For example 1.0 or 1.3." />
          <Select
            label="Status"
            value={v.status}
            onChange={(e) => {
              const status = e.target.value as DocInput['status']
              setV({ ...v, status, published: status === 'draft' ? false : v.published })
            }}
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'ratified', label: 'Ratified (replaces the current ratified version)' },
              { value: 'superseded', label: 'Superseded' },
            ]}
          />
          <Field label="Effective date (optional)" type="date" value={v.effective_date} onChange={(e) => setV({ ...v, effective_date: e.target.value })} error={errors.effective_date} />
          <label className="odz-check">
            <input type="checkbox" checked={v.published} disabled={v.status === 'draft'} onChange={(e) => setV({ ...v, published: e.target.checked })} />
            <span>Visible to members</span>
          </label>
          {errors.published && <p role="alert" style={{ color: 'var(--alert)' }}>{errors.published}</p>}
          <Textarea
            label="Text (markdown)"
            value={v.body_md}
            onChange={(e) => setV({ ...v, body_md: e.target.value })}
            error={errors.body_md}
            hint="Headings become the table of contents. No images or raw HTML."
            style={{ minHeight: '20rem' }}
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
                  await deleteDocument(id!)
                  navigate('/documents', { replace: true })
                }}
              />
            )}
          </div>
        </form>
      </Panel>
    </>
  )
}
