import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, ConfirmAction, Field, Panel, Select, Textarea } from '../components'
import {
  createEvent,
  emptyEventForm,
  EVENT_TYPES,
  groupByDay,
  listEvents,
  listPublicEvents,
  setEventStatus,
  splitUpcoming,
  updateEvent,
  validateEventForm,
  type EventDetails,
  type EventErrors,
  type EventForm,
  type EventType,
  type PublicEvent,
} from '../lib/events'
import { Markdown } from '../lib/markdown'
import { formatTimeL, toLocalInput, TZ_LABEL } from '../lib/time'
import { useLoad } from '../lib/useLoad'

type AnyEvent = PublicEvent & Partial<EventDetails>

function formFrom(e: AnyEvent): EventForm {
  return {
    title: e.title,
    event_type: e.event_type,
    starts: toLocalInput(e.starts_at),
    ends: e.ends_at ? toLocalInput(e.ends_at) : '',
    location_name: e.location_name ?? '',
    location_detail: e.location_detail ?? '',
    description: e.description ?? '',
  }
}

/**
 * /calendar. Anyone sees that an event exists (title, type, time, cancelled). Members with
 * read_event_details also see location, directions and the description; write_events holders can
 * create, edit and cancel. All data goes through lib/events.ts.
 */
export default function Calendar() {
  const { can } = useAuth()
  const detail = can('read_event_details')
  const write = can('write_events')
  const events = useLoad<AnyEvent[]>(() => (detail ? listEvents() : listPublicEvents()), [detail])
  const [editing, setEditing] = useState<{ id: string | null; form: EventForm } | null>(null)
  const [errors, setErrors] = useState<EventErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { upcoming, past } = splitUpcoming(events.data ?? [], new Date())

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const found = validateEventForm(editing.form)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    setFailure(null)
    try {
      if (editing.id) await updateEvent(editing.id, editing.form)
      else await createEvent(editing.form)
      setEditing(null)
      await events.reload()
    } catch {
      setFailure('Could not save the event.')
    }
    setBusy(false)
  }

  async function status(id: string, next: 'scheduled' | 'cancelled') {
    setFailure(null)
    try {
      await setEventStatus(id, next)
      await events.reload()
    } catch {
      setFailure('Could not change the event.')
    }
  }

  const set = (k: keyof EventForm) => (ev: { target: { value: string } }) =>
    setEditing((cur) => (cur ? { ...cur, form: { ...cur.form, [k]: ev.target.value } } : cur))

  function renderEvent(e: AnyEvent) {
    const cancelled = e.status === 'cancelled'
    return (
      <article key={e.id} className="odz-event" data-cancelled={cancelled ? '' : undefined}>
        <div className="odz-row">
          <span className="odz-event__time">
            {formatTimeL(e.starts_at)}
            {e.ends_at ? `-${formatTimeL(e.ends_at)}` : ''}
          </span>
          <Chip variant="plain">{e.event_type.toUpperCase()}</Chip>
          {cancelled && <Chip variant="alert">CANCELLED</Chip>}
        </div>
        <h3 className="odz-event__title">{e.title}</h3>
        {detail && e.location_name && <p className="odz-muted">{e.location_name}</p>}
        {detail && (e.location_detail || e.description) && (
          <details>
            <summary>Details</summary>
            {e.location_detail && (
              <p style={{ margin: '0.5rem 0', whiteSpace: 'pre-wrap' }}>{e.location_detail}</p>
            )}
            {e.description && <Markdown source={e.description} />}
          </details>
        )}
        {write && (
          <div className="odz-row" style={{ marginTop: '0.5rem' }}>
            <Button small variant="sec" onClick={() => { setErrors({}); setEditing({ id: e.id, form: formFrom(e) }) }}>
              Edit
            </Button>
            {cancelled ? (
              <Button small variant="sec" onClick={() => void status(e.id, 'scheduled')}>
                Reinstate
              </Button>
            ) : (
              <ConfirmAction label="Cancel event" confirmLabel="Confirm cancel" onConfirm={() => status(e.id, 'cancelled')} />
            )}
          </div>
        )}
      </article>
    )
  }

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '0.25rem' }}>
        Calendar
      </h1>
      <p className="odz-muted" style={{ marginBottom: '1rem' }}>
        {TZ_LABEL}
      </p>

      {write && !editing && (
        <div style={{ marginBottom: '1rem' }}>
          <Button
            onClick={() => {
              setErrors({})
              setEditing({ id: null, form: emptyEventForm })
            }}
          >
            New event
          </Button>
        </div>
      )}

      {failure && (
        <p role="alert" style={{ color: 'var(--alert)', marginBottom: '1rem' }}>
          {failure}
        </p>
      )}

      {editing && (
        <div style={{ marginBottom: '1.25rem' }}>
          <Panel title={editing.id ? 'Edit event' : 'New event'}>
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
              <div className="odz-row">
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving' : 'Save event'}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Close
                </Button>
              </div>
            </form>
          </Panel>
        </div>
      )}

      {events.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : events.failed ? (
        <p role="alert">Could not load the calendar.</p>
      ) : upcoming.length === 0 && past.length === 0 ? (
        <p className="odz-muted">No events yet.</p>
      ) : (
        <div className="odz-agenda">
          {upcoming.length === 0 && <p className="odz-muted">Nothing upcoming.</p>}
          {groupByDay(upcoming).map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h2 className="odz-day">{g.label}</h2>
              {g.events.map(renderEvent)}
            </section>
          ))}
          {past.length > 0 && (
            <details>
              <summary className="odz-label" style={{ minHeight: 'var(--touch)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                {`Past events (${past.length})`}
              </summary>
              <div className="odz-agenda" style={{ marginTop: '1rem' }}>
                {groupByDay(past).map((g) => (
                  <section key={g.key} aria-label={g.label}>
                    <h2 className="odz-day">{g.label}</h2>
                    {g.events.map(renderEvent)}
                  </section>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </>
  )
}
