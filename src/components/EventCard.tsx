import { Link } from 'react-router'
import { Chip } from './Chip'
import { audienceWords, EVENT_TYPE_LABEL, type PublicEvent } from '../lib/events'
import { formatWhen } from '../lib/time'

/**
 * An event on the list (MVA-301): just enough to find it, and the whole card is one link to the
 * event page. Date and start time, title, type in words, the member's own status, a Cancelled or
 * Completed marker, and the audience only when it is narrower than all members. Everything else
 * (place, coordinates, registration, actions) is on the page.
 */
export function EventCard({ event: e, myStatus, now }: { event: PublicEvent; myStatus?: string | null; now?: Date }) {
  const cancelled = e.status === 'cancelled'
  const narrow = e.audience === 'old_guard' || e.audience === 'command'
  return (
    <Link to={`/events/${e.id}`} className="odz-event odz-event--link" data-cancelled={cancelled ? '' : undefined}>
      <span className="odz-row">
        <span className="odz-event__time">{formatWhen(e.starts_at, null, now)}</span>
        <Chip variant="plain">{EVENT_TYPE_LABEL[e.event_type]}</Chip>
        {cancelled && <Chip variant="alert">CANCELLED</Chip>}
        {e.status === 'completed' && <Chip variant="plain">COMPLETED</Chip>}
        {narrow && <Chip variant="plain">{audienceWords(e.audience)}</Chip>}
        {myStatus && <Chip variant="go">{myStatus}</Chip>}
      </span>
      <span className="odz-event__title" role="heading" aria-level={3}>
        {e.title}
      </span>
    </Link>
  )
}
