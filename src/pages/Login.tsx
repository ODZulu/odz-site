import { useState, type FormEvent } from 'react'
import { PublicOnly } from '../auth/Gate'
import { useAuth } from '../auth/AuthProvider'
import { Button, Field, Panel } from '../components'

/**
 * Email and password only. No "forgot password" and no sign-up link: signup is invite-only and
 * not advertised, and password resets are manual (no email yet, MVA-200).
 */
export default function Login() {
  const { configured, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    setError(await signIn(email, password))
    setBusy(false)
  }

  return (
    <PublicOnly>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Sign in
      </h1>
      <Panel title="Access">
        {configured ? (
          <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error ?? undefined}
            />
            <Button type="submit" disabled={busy} block>
              {busy ? 'Signing in' : 'Sign in'}
            </Button>
            <p className="odz-muted">Locked out? Contact Command.</p>
          </form>
        ) : (
          <p className="odz-muted">Sign-in is not configured for this build.</p>
        )}
      </Panel>
    </PublicOnly>
  )
}
