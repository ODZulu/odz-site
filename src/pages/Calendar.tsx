import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, ButtonLink, Chip, ConfirmAction } from '../components'
import { EventEditor, type Editing } from '../components/EventEditor'
import { buttonClass } from '../components/Button'
import { listRegistrationEventIds, RegistrationToggle } from '../components/RegistrationPanel'
import { RsvpToggle } from '../components/RsvpPanel'
import {
  emptyEventForm,
  eventToForm,
  groupByDay,
  listEvents,
  listPublicEvents,
  setEventStatus,
  splitUpcoming,
  type EventDetails,
  type PublicEvent,
} from '../lib/events'
import { EventMapToggle } from '../components/EventMapToggle'
import { ProspectCard } from '../components/ProspectCard'
import { groupScheduleByDay, loadProspects, mergeSchedule } from '../lib/prospects'
import { ApplyCadence, CadencePanel } from '../components/CadencePanel'
import { SeriesPanel } from '../components/SeriesPanel'
import { prepTimeline } from '../lib/cadence'
import { geoLink, osmLink } from '../lib/geo'
import { AUDIENCE_LABEL } from '../lib/recurrence'
import { Markdown } from '../lib/markdown'
import { registrationMessage } from '../lib/registration'
import { supabase } from '../lib/supabase'
import { formatDateLine, formatTimeL, toLocalInput, TZ_LABEL } from '../lib/time'
import { useLoad } from '../lib/useLoad'

type AnyEvent = PublicEvent & Partial<EventDetails>

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
  // Prospects (MVA-260): open opportunities, for members who can read them. Never events, never RSVP.
  const seeProspects = can('read_opportunities')
  const prospects = useLoad(() => (seeProspects ? loadProspects(new Date()) : Promise.resolve([])), [seeProspects])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const now = new Date()
  const { upcoming, past } = splitUpcoming(events.data ?? [], now)
  const schedule = groupScheduleByDay(mergeSchedule(upcoming, prospects.data ?? [], now))

  async function status(id: string, next: 'scheduled' | 'cancelled') {
    setFailure(null)
    try {
      await setEventStatus(id, next)
      await events.reload()
    } catch {
      setFailure('Could not change the event.')
    }
  }

  async function markReviewed(id: string) {
    setFailure(null)
    const { error } = await supabase!.rpc('event_cadence_review_done', { p_event: id })
    if (error) setFailure('Could not clear the review flag.')
    await events.reload()
  }

  async function requireRegistration(id: string) {
    setFailure(null)
    const { error } = await supabase!.rpc('event_registration_configure', {
      p_event: id, p_opens_at: null, p_closes_at: null, p_capacity: null, p_cutoff_at: null,
    })
    if (error) setFailure(registrationMessage(error.message))
    await registration.reload()
  }

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
          {e.source_event_id && <Chip variant="plain">PREP</Chip>}
          {e.cadence_review && <Chip variant="alert">REVIEW: EVENT DATE CHANGED</Chip>}
          {e.audience && <Chip variant="plain">{AUDIENCE_LABEL[e.audience].toUpperCase()}</Chip>}
        </div>
        <h3 className="odz-event__title">{e.title}</h3>
        {detail && e.location_name && <p className="odz-muted">{e.location_name}</p>}
        {detail && (e.location_detail || e.description) && (
          <details>
            <summary className={buttonClass('sec', true)}>Details</summary>
            {e.location_detail && (
              <p style={{ margin: '0.5rem 0', whiteSpace: 'pre-wrap' }}>{e.location_detail}</p>
            )}
            {e.description && <Markdown source={e.description} />}
          </details>
        )}
        {detail && e.latitude != null && e.longitude != null && (
          <p className="odz-muted">
            Pin {e.latitude}, {e.longitude}{' '}
            <a href={geoLink(e.latitude, e.longitude)} className={buttonClass('sec', true)}>Open in maps app</a>{' '}
            <a href={osmLink(e.latitude, e.longitude)} target="_blank" rel="noopener noreferrer" className={buttonClass('sec', true)}>View on OpenStreetMap</a>
          </p>
        )}
        {detail && e.latitude != null && e.longitude != null && <EventMapToggle lat={e.latitude} lng={e.longitude} />}
        {detail && prepTimeline(events.data ?? [], e.id).length > 0 && (
          <details>
            <summary className={buttonClass('sec', true)}>{`Prep timeline (${prepTimeline(events.data ?? [], e.id).length})`}</summary>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {prepTimeline(events.data ?? [], e.id).map((m) => (
                <li key={m.id}>
                  {formatDateLine(m.starts_at)} {formatTimeL(m.starts_at)}: {m.title}
                  {m.status === 'cancelled' ? ' (cancelled)' : new Date(m.starts_at) < new Date() ? ' (done)' : ''}
                  {m.description ? ` - ${m.description.split(/\r?\n/)[0]}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
        {detail && e.event_type === 'Meeting' && (
          <p style={{ margin: '0.5rem 0' }}>
            <ButtonLink to={`/agenda/${e.id}`} variant="sec" small>Agenda</ButtonLink>
          </p>
        )}
        {detail && (registration.data?.has(e.id) ? <RegistrationToggle event={e} onChanged={() => void events.reload()} /> : e.status === 'completed' ? null : <RsvpToggle event={e} />)}
        {write && (
          <div className="odz-row" style={{ marginTop: '0.5rem' }}>
            <Button small variant="sec" onClick={() => setEditing({ id: e.id, form: eventToForm(e), seriesId: e.series_id ?? null })}>
              Edit
            </Button>
            <Button small variant="sec" onClick={() => { setEditing({ id: null, form: eventToForm(e, 'duplicate') }); window.scrollTo(0, 0) }}>
              Duplicate
            </Button>
            {e.status === 'scheduled' && !e.source_event_id && <ApplyCadence eventId={e.id} onDone={() => void events.reload()} />}
            {e.cadence_review && (
              <Button small variant="sec" onClick={() => void markReviewed(e.id)}>
                Mark reviewed
              </Button>
            )}
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
            onClick={() => setEditing({ id: null, form: emptyEventForm })}
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
          <EventEditor
            key={`${editing.id ?? 'new'}-${editing.form.title}`}
            initial={editing}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null)
              await events.reload()
            }}
          />
        </div>
      )}

      {write && (
        <div style={{ marginBottom: '1.25rem' }}>
          <SeriesPanel onChanged={() => void events.reload()} />
          <div style={{ height: '1.25rem' }} />
          <CadencePanel onChanged={() => void events.reload()} />
        </div>
      )}

      {events.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : events.failed ? (
        <p role="alert">Could not load the calendar.</p>
      ) : upcoming.length === 0 && past.length === 0 && schedule.length === 0 ? (
        <p className="odz-muted">No events yet.</p>
      ) : (
        <div className="odz-agenda">
          {schedule.length === 0 && <p className="odz-muted">Nothing upcoming.</p>}
          {schedule.map((g) => (
            <section key={g.key} aria-label={formatDateLine(`${g.key}T12:00:00-07:00`)}>
              <h2 className="odz-day">{formatDateLine(`${g.key}T12:00:00-07:00`)}</h2>
              {g.items.map((i) => (i.kind === 'event' ? renderEvent(i.event) : <ProspectCard key={`p-${i.prospect.id}`} prospect={i.prospect} />))}
            </section>
          ))}
          {past.length > 0 && (
            <details>
              <summary className={buttonClass('sec', true)}>
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
