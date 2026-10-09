import { Panel } from '../components'

export default function Calendar() {
  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Calendar
      </h1>
      <Panel title="Public calendar">
        <p className="odz-muted">Placeholder. Events arrive with the calendar ticket.</p>
      </Panel>
    </>
  )
}
