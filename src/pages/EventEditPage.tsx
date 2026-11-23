import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { ButtonLink } from '../components'
import { EventEditor } from '../components/EventEditor'
import { eventToForm, getEvent } from '../lib/events'
import { useLoad } from '../lib/useLoad'

/**
 * Edit or duplicate an event on its own page (MVA-301): heading first, then the form, with focus in it.
 * Same capability check as the calendar (`write_events`); anyone else is sent back to the event page,
 * which itself sends a signed-out visitor to login.
 */
export default function EventEditPage({ mode }: { mode: 'edit' | 'duplicate' }) {
  const { eventId = '' } = useParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const write = can('write_events')
  const data = useLoad(() => (write ? getEvent(eventId, true) : Promise.resolve(null)), [eventId, write])

  if (!write) return <Navigate to={`/events/${eventId}`} replace />
  if (data.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  const e = data.data
  if (!e) {
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

  // Close and Cancel go back to where the member came from; opened directly, to the event page.
  const leave = () => (location.key !== 'default' ? navigate(-1) : navigate(`/events/${eventId}`, { replace: true }))
  const heading = mode === 'edit' ? 'Edit event' : 'Duplicate event'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <header>
        <h1 className="odz-title">{heading}</h1>
        <p className="odz-muted" style={{ margin: '0.25rem 0 0' }}>
          {mode === 'edit' ? e.title : `Copy of ${e.title}. Set a new date and time.`}
        </p>
      </header>
      <EventEditor
        initial={
          mode === 'edit'
            ? { id: e.id, form: eventToForm(e), seriesId: e.series_id ?? null }
            : { id: null, form: eventToForm(e, 'duplicate') }
        }
        panelTitle="Event details"
        autoFocus
        onClose={leave}
        // An edit opened from the event page goes back to it (the page reloads on return); otherwise
        // replace the form in history so Back from the event page never lands on a saved form.
        onSaved={(id) =>
          mode === 'edit' && (location.state as { fromEvent?: boolean } | null)?.fromEvent
            ? navigate(-1)
            : navigate(`/events/${id ?? e.id}`, { replace: true })
        }
      />
    </div>
  )
}
