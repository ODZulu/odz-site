import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, ConfirmAction, Field, Panel, Select, Textarea } from '../components'
import { listRegistrationEventIds, RegistrationToggle } from '../components/RegistrationPanel'
import { RsvpToggle } from '../components/RsvpPanel'
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
  type EventAudience,
  type EventErrors,
  type EventForm,
  type EventType,
  type PublicEvent,
} from '../lib/events'
import { PinFields } from '../components/PinFields'
import { SeriesPanel } from '../components/SeriesPanel'
import { geoLink, osmLink } from '../lib/geo'
import { AUDIENCE_LABEL } from '../lib/recurrence'
import { Markdown } from '../lib/markdown'
import { registrationMessage } from '../lib/registration'
import { supabase } from '../lib/supabase'
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
    latitude: e.latitude == null ? '' : String(e.latitude),
    longitude: e.longitude == null ? '' : String(e.longitude),
    hide_from_public_map: e.hide_from_public_map ?? false,
    completed: false,
    audience: (e.audience ?? '') as EventAudience,
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
  // Events that use registration show it instead of RSVP and readiness (one "going" state per event, MVA-231).
  const registration = useLoad(async () => (detail ? await listRegistrationEventIds() : new Set<string>()), [detail])
  const [editing, setEditing] = useState<{ id: string | null; form: EventForm; seriesId?: string | null } | null>(null)
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

  async function requireRegistration(id: string) {
    setFailure(null)
    const { error } = await supabase!.rpc('event_registration_configure', {
      p_event: id, p_opens_at: null, p_closes_at: null, p_capacity: null, p_cutoff_at: null,
    })
    if (error) setFailure(registrationMessage(error.message))
    await registration.reload()
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
          {e.status === 'completed' && <Chip variant="plain">COMPLETED</Chip>}
          {e.audience && <Chip variant="plain">{AUDIENCE_LABEL[e.audience].toUpperCase()}</Chip>}
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
        {detail && e.latitude != null && e.longitude != null && (
          <p className="odz-muted">
            Pin {e.latitude}, {e.longitude}{' '}
            <a href={geoLink(e.latitude, e.longitude)}>Open in maps app</a>{' · '}
            <a href={osmLink(e.latitude, e.longitude)} target="_blank" rel="noopener noreferrer">View on OpenStreetMap</a>
          </p>
        )}
        {detail && e.event_type === 'Meeting' && (
          <p style={{ margin: '0.5rem 0' }}>
            <Link to={`/agenda/${e.id}`}>Agenda</Link>
          </p>
        )}
        {detail && (registration.data?.has(e.id) ? <RegistrationToggle event={e} onChanged={() => void events.reload()} /> : e.status === 'completed' ? null : <RsvpToggle event={e} />)}
        {write && (
          <div className="odz-row" style={{ marginTop: '0.5rem' }}>
            <Button small variant="sec" onClick={() => { setErrors({}); setEditing({ id: e.id, form: formFrom(e), seriesId: e.series_id ?? null }) }}>
              Edit
            </Button>
            <Button small variant="sec" onClick={() => { setErrors({}); setEditing({ id: null, form: { ...formFrom(e), starts: '', ends: '', completed: false } }); window.scrollTo(0, 0) }}>
              Duplicate
            </Button>
            {e.status === 'scheduled' && !registration.data?.has(e.id) && (
              <Button small variant="sec" onClick={() => void requireRegistration(e.id)}>
                Require registration
              </Button>
            )}
            {e.status === 'completed' ? null : cancelled ? (
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
                onChange={(patch) => setEditing((cur) => (cur ? { ...cur, form: { ...cur.form, ...patch } } : cur))}
              />
              {!editing.id && (
                <label className="odz-row" style={{ gap: '0.5rem', minHeight: '2.5rem' }}>
                  <input type="checkbox" checked={editing.form.completed} onChange={(ev) => setEditing((cur) => (cur ? { ...cur, form: { ...cur.form, completed: ev.target.checked } } : cur))} />
                  Past mission: record as completed
                </label>
              )}
              {errors.completed && <p role="alert" style={{ color: 'var(--alert)' }}>{errors.completed}</p>}
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

      {write && (
        <div style={{ marginBottom: '1.25rem' }}>
          <SeriesPanel onChanged={() => void events.reload()} />
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
