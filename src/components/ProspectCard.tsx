import { ButtonLink } from './Button'
import { Chip } from './Chip'
import { prospectHref, type Prospect } from '../lib/prospects'
import { formatPlainDate } from '../lib/time'

const dates = (p: Prospect): string =>
  p.ends_on && p.ends_on !== p.starts_on ? `${formatPlainDate(p.starts_on)} to ${formatPlainDate(p.ends_on)}` : formatPlainDate(p.starts_on)

/**
 * A prospect in the calendar (MVA-260): an outside opportunity the team has not committed to. It
 * is drawn differently from an event (dashed border, PROSPECT label) and has no RSVP, registration
 * or readiness; the only action opens the opportunity, where interest is answered.
 */
export function ProspectCard({ prospect }: { prospect: Prospect }) {
  return (
    <article className="odz-event odz-event--prospect" aria-label={`Prospect: ${prospect.title}`}>
      <div className="odz-row">
        <Chip variant="accent">PROSPECT</Chip>
        <span className="odz-muted">{dates(prospect)}</span>
      </div>
      <h3 className="odz-event__title">{prospect.title}</h3>
      {prospect.location_text && <p className="odz-muted">{prospect.location_text}</p>}
      <p className="odz-muted">Not an event yet. Answer interest on the opportunity.</p>
      <p style={{ margin: '0.5rem 0 0' }}>
        <ButtonLink to={prospectHref(prospect.id)} variant="sec" small>
          View opportunity
        </ButtonLink>
      </p>
    </article>
  )
}
