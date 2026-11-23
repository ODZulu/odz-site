import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createEvent,
  EVENT_TYPES,
  updateEvent,
  validateEventForm,
  type EventErrors,
  type EventForm,
  type EventType,
} from '../lib/events'
import { AUDIENCE_LABEL } from '../lib/recurrence'
import { Button } from './Button'
import { Field } from './Field'
import { PinFields } from './PinFields'
import { Panel } from './Panel'
import { Select } from './Select'
import { Textarea } from './Textarea'

export type Editing = { id: string | null; form: EventForm; seriesId?: string | null }

/**
 * The create / edit / duplicate form for an event (MVA-301: shared by the calendar's New event and the
 * event page's Edit and Duplicate). Validation and saving are unchanged; `onSaved` runs after a save.
 */
export function EventEditor({
  initial,
  onSaved,
  onClose,
  panelTitle,
  autoFocus = false,
}: {
  initial: Editing
  /** Runs after a save, with the saved event's id (null if the database did not return one). */
  onSaved: (id: string | null) => void | Promise<void>
  onClose: () => void
  /** Overrides the panel heading (a page that already has its own h1 uses this). */
  panelTitle?: string
  /** Put focus in the first field on mount. */
  autoFocus?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (autoFocus) box.current?.querySelector('input')?.focus()
  }, [autoFocus])
  const [editing, setEditing] = useState(initial)
  const [errors, setErrors] = useState<EventErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (k: keyof EventForm) => (ev: { target: { value: string } }) =>
    setEditing((cur) => ({ ...cur, form: { ...cur.form, [k]: ev.target.value } }))

  async function save(e: FormEvent) {
    e.preventDefault()
    const found = validateEventForm(editing.form)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    setFailure(null)
    try {
      let id = editing.id
      if (editing.id) await updateEvent(editing.id, editing.form)
      else id = await createEvent(editing.form)
      await onSaved(id)
    } catch {
      setFailure('Could not save the event.')
      setBusy(false)
    }
  }

  return (
    <Panel title={panelTitle ?? (editing.id ? 'Edit event' : 'New event')}>
      <div ref={box}>
      <form onSubmit={save} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Field label="Title" maxLength={120} value={editing.form.title} onChange={set('title')} error={errors.title} />
        <Select
          label="Type"
          value={editing.form.event_type}
          onChange={(ev) => set('event_type')({ target: { value: ev.target.value as EventType } })}
          options={EVENT_TYPES.map((t) => ({ value: t, label: t }))}
        />
        <Field label="Starts (Phoenix time)" type="datetime-local" value={editing.form.starts} onChange={set('starts')} error={errors.starts} />
        <Field label="Ends (optional)" type="datetime-local" value={editing.form.ends} onChange={set('ends')} error={errors.ends} />
        <Field label="Location name" maxLength={120} value={editing.form.location_name} onChange={set('location_name')} error={errors.location_name} hint="Members only." />
        <Textarea label="Directions and address" maxLength={1000} value={editing.form.location_detail} onChange={set('location_detail')} error={errors.location_detail} hint="Members only." />
        <Textarea label="Description (markdown)" maxLength={5000} value={editing.form.description} onChange={set('description')} error={errors.description} hint="Members only. Plain markdown; no images or raw HTML." />
        <Select
          label="Who can see this event"
          value={editing.form.audience}
          onChange={(ev) => set('audience')({ target: { value: ev.target.value } })}
          options={[
            { value: '', label: 'Everyone (public listing)' },
            { value: 'members', label: AUDIENCE_LABEL.members },
            { value: 'old_guard', label: AUDIENCE_LABEL.old_guard },
            { value: 'command', label: AUDIENCE_LABEL.command },
          ]}
        />
        {editing.seriesId && <p className="odz-muted">This meeting belongs to a standing series. Saving here changes only this meeting; to change the series use Standing meetings below.</p>}
        <PinFields
          latitude={editing.form.latitude}
          longitude={editing.form.longitude}
          hidden={editing.form.hide_from_public_map}
          error={errors.latitude}
          onChange={(patch) => setEditing((cur) => ({ ...cur, form: { ...cur.form, ...patch } }))}
        />
        {!editing.id && (
          <label className="odz-row" style={{ gap: '0.5rem', minHeight: '2.5rem' }}>
            <input type="checkbox" checked={editing.form.completed} onChange={(ev) => setEditing((cur) => ({ ...cur, form: { ...cur.form, completed: ev.target.checked } }))} />
            Past mission: record as completed
          </label>
        )}
        {errors.completed && <p role="alert" style={{ color: 'var(--alert)' }}>{errors.completed}</p>}
        {failure && <p role="alert" style={{ color: 'var(--alert)' }}>{failure}</p>}
        <div className="odz-row">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving' : 'Save event'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </form>
      </div>
    </Panel>
  )
}
