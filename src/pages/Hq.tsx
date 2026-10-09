import { Chip, KeyValue, Panel } from '../components'

// Placeholder content only (obviously fake; the repo is public). Replaced by real events when
// the calendar lands (MVA-201). HQ in v1 is next event + schedule; readiness, traffic and the
// tier breakdown wait in the Backlog (MVA-142).
const nextEvent = {
  title: 'Sample Event',
  details: [
    ['AO', 'Sample Field'],
    ['Host', 'Sample Host'],
    ['D-Day', 'TBD'],
  ] as Array<[string, string]>,
}

const schedule = [
  { day: '04', month: 'OCT', title: 'Sample Meeting', where: 'Sample Venue', kind: 'ADMIN' },
  { day: '18', month: 'OCT', title: 'Sample Training', where: 'Sample Field', kind: 'TRAINING' },
]

export default function Hq() {
  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        HQ
      </h1>
      <div className="odz-grid">
        <Panel title="Next event" action={<Chip variant="accent">Sample data</Chip>}>
          <p className="odz-title">{nextEvent.title}</p>
          <div style={{ marginTop: '0.75rem' }}>
            <KeyValue items={nextEvent.details} />
          </div>
        </Panel>
        <Panel title="Schedule">
          {schedule.map((s) => (
            <div className="odz-sched" key={s.title}>
              <div className="odz-date">
                <b>{s.day}</b>
                <span className="odz-label">{s.month}</span>
              </div>
              <div className="odz-sched__body">
                <p className="odz-heading">{s.title}</p>
                <p className="odz-label">{s.where}</p>
              </div>
              <Chip variant="plain">{s.kind}</Chip>
            </div>
          ))}
        </Panel>
      </div>
    </>
  )
}
