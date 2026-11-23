import { lazy, Suspense, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, ButtonLink, Chip, ConfirmAction, KeyValue, Panel } from '../components'
import { buttonClass } from '../components/Button'
import { ApplyCadence } from '../components/CadencePanel'
import { RegistrationPanel } from '../components/RegistrationPanel'
import { RsvpPanel } from '../components/RsvpPanel'
import {
  audienceWords,
  eventTimeRange,
  EVENT_TYPE_LABEL,
  getEvent,
  isOpenForSignup,
  listPrepMeetings,
  setEventStatus,
} from '../lib/events'
import { geoLink, osmLink } from '../lib/geo'
import { Markdown } from '../lib/markdown'
import { registrationMessage } from '../lib/registration'
import { supabase } from '../lib/supabase'
import { formatDateLine, formatTimeL } from '../lib/time'
import { useLoad } from '../lib/useLoad'

const PinMap = lazy(() => import('../components/PinMap'))

type Loaded = {
  event: NonNullable<Awaited<ReturnType<typeof getEvent>>>
  usesRegistration: boolean
  prep: Awaited<ReturnType<typeof listPrepMeetings>>
  source: { id: string; title: string } | null
  seriesTitle: string | null
}

async function load(id: string, detail: boolean): Promise<Loaded | null> {
  const event = await getEvent(id, detail)
  if (!event) return null
  if (!detail || !supabase) return { event, usesRegistration: false, prep: [], source: null, seriesTitle: null }
  const [reg, prep, source, series] = await Promise.all([
    supabase.from('event_registration_settings').select('event_id').eq('event_id', id).maybeSingle(),
    listPrepMeetings(id),
    event.source_event_id ? getEvent(event.source_event_id, false) : Promise.resolve(null),
    // A series is readable to the people the database lets read it; anyone else just sees the plain note.
    event.series_id ? supabase.from('event_series').select('title').eq('id', event.series_id).maybeSingle() : Promise.resolve(null),
  ])
  return {
    event,
    usesRegistration: !reg.error && reg.data !== null,
    prep,
    source: source ? { id: source.id, title: source.title } : null,
    seriesTitle: series && !series.error ? ((series.data as { title: string } | null)?.title ?? null) : null,
  }
}

/**
 * One event (MVA-301). The list shows where and when; this page shows everything else, in a fixed
 * order of headed sections. Reads and actions are the ones the calendar card already used: what a
 * reader may see is decided by row-level security, this page only shows what it was given.
 */
export default function EventPage() {
  const { eventId = '' } = useParams()
  const { can, session } = useAuth()
  const navigate = useNavigate()
  const detail = can('read_event_details')
  const write = can('write_events')
  const data = useLoad(() => load(eventId, detail), [eventId, detail])
  const [failure, setFailure] = useState<string | null>(null)

  if (data.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  const d = data.data
  if (!d) {
    // No row for this reader. Signed out, a member-only event looks the same as a missing one, so ask for a sign-in.
    if (!session && !data.failed) return <Navigate to="/login" replace />
    return (
      <>
        <h1 className="odz-title">{data.failed ? 'Could not load the event' : 'Event not found'}</h1>
        <p>
          <ButtonLink to="/calendar" variant="sec" small>
            Back to the calendar
          </ButtonLink>
        </p>
      </>
    )
  }

  const { event: e, usesRegistration, prep, source, seriesTitle } = d
  const cancelled = e.status === 'cancelled'
  const hasPin = detail && e.latitude != null && e.longitude != null
  const now = new Date()

  async function status(next: 'scheduled' | 'cancelled') {
    setFailure(null)
    try {
      await setEventStatus(e.id, next)
      await data.reload()
    } catch {
      setFailure('Could not change the event.')
    }
  }

  async function markReviewed() {
    setFailure(null)
    const { error } = await supabase!.rpc('event_cadence_review_done', { p_event: e.id })
    if (error) setFailure('Could not clear the review flag.')
    await data.reload()
  }

  async function requireRegistration() {
    setFailure(null)
    const { error } = await supabase!.rpc('event_registration_configure', {
      p_event: e.id, p_opens_at: null, p_closes_at: null, p_capacity: null, p_cutoff_at: null,
    })
    if (error) setFailure(registrationMessage(error.message))
    await data.reload()
  }

  return (
    <div className="odz-stack" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ margin: 0 }}>
        <Link to="/calendar" className={buttonClass('ghost', true)} onClick={(ev) => { if (window.history.length > 1) { ev.preventDefault(); navigate(-1) } }}>
          Back
        </Link>
      </p>

      <header>
        <div className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
          <Chip variant="plain">{EVENT_TYPE_LABEL[e.event_type]}</Chip>
          {cancelled && <Chip variant="alert">CANCELLED</Chip>}
          {e.status === 'completed' && <Chip variant="plain">COMPLETED</Chip>}
          {e.cadence_review && <Chip variant="alert">REVIEW: EVENT DATE CHANGED</Chip>}
        </div>
        <h1 className="odz-title" data-cancelled={cancelled ? '' : undefined} style={cancelled ? { textDecoration: 'line-through' } : undefined}>
          {e.title}
        </h1>
        <p className="odz-muted" style={{ margin: '0.25rem 0 0' }}>
          {formatDateLine(e.starts_at)} · {eventTimeRange(e)}
          {detail ? ` · ${audienceWords(e.audience)}` : ''}
        </p>
        {source && (
          <p style={{ margin: '0.5rem 0 0' }}>
            Prep meeting for <Link to={`/events/${source.id}`}>{source.title}</Link>
          </p>
        )}
        {e.series_id && (
          <p className="odz-muted" style={{ margin: '0.5rem 0 0' }}>
            {seriesTitle ? `Part of the standing series: ${seriesTitle}.` : 'Part of a standing meeting series.'}
          </p>
        )}
      </header>

      {write && (
        <div className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <ButtonLink to={`/events/${e.id}/edit`} state={{ fromEvent: true }} variant="sec" small>
            Edit
          </ButtonLink>
          <ButtonLink to={`/events/${e.id}/duplicate`} variant="sec" small>
            Duplicate
          </ButtonLink>
          {e.status === 'scheduled' && !e.source_event_id && <ApplyCadence eventId={e.id} onDone={() => void data.reload()} />}
          {e.cadence_review && (
            <Button small variant="sec" onClick={() => void markReviewed()}>
              Mark reviewed
            </Button>
          )}
          {e.status === 'scheduled' && !usesRegistration && (
            <Button small variant="sec" onClick={() => void requireRegistration()}>
              Require registration
            </Button>
          )}
          {e.status === 'completed' ? null : cancelled ? (
            <Button small variant="sec" onClick={() => void status('scheduled')}>
              Reinstate
            </Button>
          ) : (
            <ConfirmAction label="Cancel event" confirmLabel="Confirm cancel" onConfirm={() => status('cancelled')} />
          )}
        </div>
      )}

      {failure && (
        <p role="alert" style={{ color: 'var(--alert)', margin: 0 }}>
          {failure}
        </p>
      )}

      <Panel title="When and where">
        <KeyValue
          items={[
            ['Date', formatDateLine(e.starts_at)],
            ['Time', `${formatTimeL(e.starts_at)}${e.ends_at ? ` to ${formatTimeL(e.ends_at)}` : ''}`],
            ...(detail ? ([['Location', e.location_name || 'Not set']] as Array<[string, string]>) : []),
          ]}
        />
        {!detail && <p className="odz-muted">Location and details are shown to signed-in members.</p>}
        {hasPin && (
          <div className="odz-stack" style={{ marginTop: '0.75rem' }}>
            <Suspense fallback={<p className="odz-muted" role="status">Loading map</p>}>
              <PinMap value={{ lat: e.latitude as number, lng: e.longitude as number }} editable={false} height={200} />
            </Suspense>
            <div className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <a href={geoLink(e.latitude as number, e.longitude as number)} className={buttonClass('sec', true)}>
                Open in maps
              </a>
              <a href={osmLink(e.latitude as number, e.longitude as number)} target="_blank" rel="noopener noreferrer" className={buttonClass('sec', true)}>
                View on OpenStreetMap
              </a>
            </div>
            <p className="odz-muted">
              Coordinates {e.latitude}, {e.longitude}
            </p>
          </div>
        )}
      </Panel>

      {detail && (
        <Panel title="Details">
          {e.location_detail || e.description ? (
            <>
              {e.location_detail && <p style={{ margin: '0 0 0.5rem', whiteSpace: 'pre-wrap' }}>{e.location_detail}</p>}
              {e.description && <Markdown source={e.description} />}
            </>
          ) : (
            <p className="odz-muted">No details yet.</p>
          )}
        </Panel>
      )}

      {detail && e.event_type === 'Meeting' && (
        <Panel title="Agenda">
          <ButtonLink to={`/agenda/${e.id}`} variant="sec" small>
            Open the agenda
          </ButtonLink>
        </Panel>
      )}

      {detail && prep.length > 0 && (
        <Panel title="Prep timeline">
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {prep.map((m) => (
              <li key={m.id}>
                <Link to={`/events/${m.id}`}>{m.title}</Link>: {formatDateLine(m.starts_at)} {formatTimeL(m.starts_at)}
                {m.status === 'cancelled' ? ' (cancelled)' : new Date(m.starts_at) < now ? ' (done)' : ''}
                {m.description ? ` - ${m.description.split(/\r?\n/)[0]}` : ''}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {detail && usesRegistration && <RegistrationPanel layout="page" event={e} onChanged={() => void data.reload()} />}

      {detail && !usesRegistration && (
        <Panel title="Registration">
          {e.status === 'completed' ? (
            <p className="odz-muted">Registration was not used for this event.</p>
          ) : (
            <>
              <p className="odz-muted">
                This event does not use registration.
                {isOpenForSignup(e, now) ? ' Answer below so the team can plan.' : ' Answers are closed.'}
              </p>
              <RsvpPanel event={e} />
            </>
          )}
        </Panel>
      )}
    </div>
  )
}
