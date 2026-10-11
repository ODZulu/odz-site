import { Panel } from '../components'

export default function Roster() {
  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Roster
      </h1>
      <Panel title="Members area">
        <p className="odz-muted">The roster list arrives with a later ticket.</p>
      </Panel>
    </>
  )
}
