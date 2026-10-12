import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, Panel } from '../components'

/** Shown to pending accounts: nothing else is readable (RLS), and they can sign out. */
export function Pending() {
  const { signOut } = useAuth()
  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Account pending approval
      </h1>
      <Panel title="Status" action={<Chip variant="pending" />}>
        <p>Your account is set up. Command will approve it. You can sign in again later to check.</p>
        <div style={{ marginTop: '1rem' }}>
          <Button variant="sec" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Panel>
    </>
  )
}

/** Shown to suspended accounts. Deliberately says nothing about why. */
export function Denied() {
  const { signOut } = useAuth()
  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Access denied
      </h1>
      <Panel title="Status" action={<Chip variant="alert" />}>
        <p>This account cannot be used.</p>
        <div style={{ marginTop: '1rem' }}>
          <Button variant="sec" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Panel>
    </>
  )
}
