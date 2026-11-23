import { useMemo } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { ButtonLink } from '../components'
import { buttonClass } from '../components/Button'
import { CadencePanel } from '../components/CadencePanel'
import { EventCard } from '../components/EventCard'
import { ProspectCard } from '../components/ProspectCard'
import { SeriesPanel } from '../components/SeriesPanel'
import { groupByDay, listEvents, listPublicEvents, splitUpcoming, type EventDetails, type PublicEvent } from '../lib/events'
import { loadOwnStatuses, ownStatusFor } from '../lib/myStatus'
import { groupScheduleByDay, loadProspects, mergeSchedule } from '../lib/prospects'
import { formatDateLine, TZ_LABEL } from '../lib/time'
import { readFlag, saveFlag, useListScroll } from '../lib/useListScroll'
import { useLoad } from '../lib/useLoad'

type AnyEvent = PublicEvent & Partial<EventDetails>

/**
 * /calendar (MVA-301). The list: each event is one card linking to its own page, where everything
 * else (place, registration, actions) lives. Anyone sees that an event exists; members with
 * read_event_details also see their own status on each card; write_events holders can start a new
 * event and manage standing meetings and prep cadences. All data goes through lib/events.ts.
 */
export default function Calendar() {
  const { can, session } = useAuth()
  const detail = can('read_event_details')
  const write = can('write_events')
  const uid = session?.user.id ?? null
  const events = useLoad<AnyEvent[]>(() => (detail ? listEvents() : listPublicEvents()), [detail])
  // The member's own registration and RSVP rows, for the one-word status on each card.
  const own = useLoad(() => (detail ? loadOwnStatuses(uid) : Promise.resolve(null)), [detail, uid])
  // Prospects (MVA-260): open opportunities, for members who can read them. Never events, never RSVP.
  const seeProspects = can('read_opportunities')
  const prospects = useLoad(() => (seeProspects ? loadProspects(new Date()) : Promise.resolve([])), [seeProspects])
  useListScroll('calendar', !events.loading)

  const now = useMemo(() => new Date(), [])
  const { upcoming, past } = splitUpcoming(events.data ?? [], now)
  const schedule = groupScheduleByDay(mergeSchedule(upcoming, prospects.data ?? [], now))
  const card = (e: AnyEvent) => <EventCard key={e.id} event={e} now={now} myStatus={ownStatusFor(own.data, e.id, e.status)} />

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '0.25rem' }}>
        Calendar
      </h1>
      <p className="odz-muted" style={{ marginBottom: '1rem' }}>
        {TZ_LABEL}
      </p>

      {write && (
        <p style={{ marginBottom: '1rem' }}>
          <ButtonLink to="/events/new">New event</ButtonLink>
        </p>
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
              {g.items.map((i) => (i.kind === 'event' ? card(i.event) : <ProspectCard key={`p-${i.prospect.id}`} prospect={i.prospect} />))}
            </section>
          ))}
          {past.length > 0 && (
            <details open={readFlag('calendar-past')} onToggle={(ev) => saveFlag('calendar-past', (ev.currentTarget as HTMLDetailsElement).open)}>
              <summary className={buttonClass('sec', true)}>{`Past events (${past.length})`}</summary>
              <div className="odz-agenda" style={{ marginTop: '1rem' }}>
                {groupByDay(past).map((g) => (
                  <section key={g.key} aria-label={g.label}>
                    <h2 className="odz-day">{g.label}</h2>
                    {g.events.map(card)}
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
