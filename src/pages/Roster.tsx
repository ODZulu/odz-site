import { Chip, Panel } from '../components'

export default function Roster() {
  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Roster
      </h1>
      <Panel title="Members area" action={<Chip variant="alert">NOT PROTECTED</Chip>}>
        <p>This route is a stub and is not secured. Real protection comes with the auth ticket.</p>
      </Panel>
    </>
  )
}
