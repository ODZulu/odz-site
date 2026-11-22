import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { ButtonLink, Chip, KeyValue, Panel, Sep } from '../components'
import { ReadinessMeter } from '../components/ReadinessMeter'
import { loadProspects, mergeSchedule, prospectHref } from '../lib/prospects'
import { listEvents, listPublicEvents, splitUpcoming, type EventDetails, type PublicEvent } from '../lib/events'
import { authorLabel, breakdownBars, loadReadiness, loadTierBreakdown, loadTraffic } from '../lib/hq'
import { formatDateLine, formatStampPhoenix, formatTimeL } from '../lib/time'
import { useLoad } from '../lib/useLoad'

type AnyEvent = PublicEvent & Partial<EventDetails>

const monthOf = (iso: string) => formatDateLine(iso).split(' ')[2]
const dayOf = (iso: string) => formatDateLine(iso).split(' ')[1]

/** Logged-in home: next event with readiness, schedule, traffic and the tier breakdown. Each panel has an empty state. */
export default function Hq() {
  const { can } = useAuth()
  const detail = can('read_event_details')

  const events = useLoad<AnyEvent[]>(() => (detail ? listEvents() : listPublicEvents()), [detail])
  const upcoming = splitUpcoming(events.data ?? [], new Date()).upcoming.filter((e) => e.status === 'scheduled')
  const next = upcoming[0]
  // Prospects (MVA-260) join the schedule only. They are never "next event" and carry no readiness.
  const seeProspects = can('read_opportunities')
  const prospects = useLoad(() => (seeProspects ? loadProspects(new Date()) : Promise.resolve([])), [seeProspects])
  const schedule = mergeSchedule(upcoming, prospects.data ?? [], new Date())

  const readiness = useLoad(() => (next && detail ? loadReadiness(next.id) : Promise.resolve(null)), [next?.id, detail])
  const traffic = useLoad(() => loadTraffic(5))
  const breakdown = useLoad(loadTierBreakdown)

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        HQ
      </h1>
      <div className="odz-grid">
        <div className="odz-col">
          <Panel title="Next event" action={next ? <Chip variant="plain">{next.event_type.toUpperCase()}</Chip> : undefined}>
            {events.loading ? (
              <p className="odz-muted" role="status">
                Loading
              </p>
            ) : !next ? (
              <p className="odz-muted">Nothing scheduled.</p>
            ) : (
              <>
                <Link to="/calendar" className="odz-title" style={{ textDecoration: 'none' }}>
                  {next.title}
                </Link>
                <div style={{ marginTop: '0.75rem' }}>
                  <KeyValue
                    items={[
                      ['When', `${formatDateLine(next.starts_at)} · ${formatTimeL(next.starts_at)}`],
                      ...(detail && next.location_name ? ([['Where', next.location_name]] as Array<[string, string]>) : []),
                    ]}
                  />
                </div>
                {readiness.data && (
                  <div style={{ marginTop: '1rem' }}>
                    <Link to="/calendar" aria-label="Open the event to answer">
                      <ReadinessMeter readiness={readiness.data} />
                    </Link>
                  </div>
                )}
              </>
            )}
          </Panel>

          <Panel title="Traffic" action={<ButtonLink to="/traffic" variant="sec" small>More</ButtonLink>}>
            {traffic.loading ? (
              <p className="odz-muted" role="status">
                Loading
              </p>
            ) : traffic.failed ? (
              <p role="alert">Could not load traffic.</p>
            ) : (traffic.data?.posts ?? []).length === 0 ? (
              <p className="odz-muted">No traffic.</p>
            ) : (
              (traffic.data?.posts ?? []).map((p) => (
                <article key={p.id} className="odz-post">
                  <div className="odz-row">
                    {p.pinned && <Chip variant="accent">PINNED</Chip>}
                    <span className="odz-label">
                      {authorLabel(p.author)}
                      <Sep />
                      {formatStampPhoenix(p.created_at)}
                    </span>
                  </div>
                  <h3 className="odz-post__title">{p.title}</h3>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
                </article>
              ))
            )}
          </Panel>
        </div>

        <div className="odz-col">
          <Panel title="Schedule" action={<ButtonLink to="/calendar" variant="sec" small>Calendar</ButtonLink>}>
            {events.loading ? (
              <p className="odz-muted" role="status">
                Loading
              </p>
            ) : schedule.length === 0 ? (
              <p className="odz-muted">Nothing scheduled.</p>
            ) : (
              schedule.slice(0, 5).map((i) =>
                i.kind === 'event' ? (
                  <div className="odz-sched" key={i.event.id}>
                    <div className="odz-date">
                      <b>{dayOf(i.event.starts_at)}</b>
                      <span className="odz-label">{monthOf(i.event.starts_at)}</span>
                    </div>
                    <div className="odz-sched__body">
                      <p className="odz-heading">{i.event.title}</p>
                      <p className="odz-label">
                        {formatTimeL(i.event.starts_at)}
                        {detail && i.event.location_name && (
                          <>
                            <Sep />
                            {i.event.location_name}
                          </>
                        )}
                      </p>
                    </div>
                    <Chip variant="plain">{i.event.event_type.toUpperCase()}</Chip>
                  </div>
                ) : (
                  <div className="odz-sched odz-sched--prospect" key={`p-${i.prospect.id}`}>
                    <div className="odz-date">
                      <b>{i.prospect.starts_on.slice(8, 10)}</b>
                      <span className="odz-label">{formatDateLine(`${i.prospect.starts_on}T12:00:00-07:00`).split(' ')[2]}</span>
                    </div>
                    <div className="odz-sched__body">
                      <p className="odz-heading">
                        <Link to={prospectHref(i.prospect.id)} style={{ textDecoration: 'none' }}>
                          {i.prospect.title}
                        </Link>
                      </p>
                      <p className="odz-label">{i.prospect.location_text ?? 'Not an event yet'}</p>
                    </div>
                    <Chip variant="accent">PROSPECT</Chip>
                  </div>
                ),
              )
            )}
          </Panel>

          <Panel title="Tier breakdown">
            {breakdown.loading ? (
              <p className="odz-muted" role="status">
                Loading
              </p>
            ) : breakdown.failed || !breakdown.data ? (
              <p role="alert">Could not load the breakdown.</p>
            ) : breakdown.data.every((r) => r.member_count === 0) ? (
              <p className="odz-muted">No members yet.</p>
            ) : (
              <div className="odz-bars">
                {breakdownBars(breakdown.data).map((b) => (
                  <div key={b.tier_name} className="odz-bar-row">
                    <span className="odz-label">{b.tier_name}</span>
                    <span className="odz-bar-row__track" aria-hidden="true">
                      <span className="odz-bar-row__fill" style={{ width: `${Math.round(b.share * 100)}%` }} />
                    </span>
                    <b>{b.member_count}</b>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}
