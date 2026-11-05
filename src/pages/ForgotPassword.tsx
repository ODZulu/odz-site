import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { PublicOnly } from '../auth/Gate'
import { Button, Field, Panel } from '../components'
import { NEUTRAL_RESET_MESSAGE, resetUrl, validateForgot } from '../lib/recovery'
import { supabase } from '../lib/supabase'

/**
 * Asks Supabase to email a reset link (MVA-200). The answer is always the same neutral message:
 * known, unknown, pending, suspended or removed address, even a send failure. Nothing here
 * reveals whether an account exists, and the address is never logged.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const problem = validateForgot(email)
    if (problem) return setError(problem)
    setError(null)
    setBusy(true)
    try {
      await supabase?.auth.resetPasswordForEmail(email.trim(), { redirectTo: resetUrl(window.location.origin) })
    } catch {
      // Deliberately ignored: the visitor must not be able to tell success from failure.
    }
    setBusy(false)
    setSent(true)
  }

  return (
    <PublicOnly>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Reset password
      </h1>
      <Panel title="Email">
        {sent ? (
          <p role="status">{NEUTRAL_RESET_MESSAGE}</p>
        ) : supabase ? (
          <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error ?? undefined}
            />
            <Button type="submit" disabled={busy} block>
              {busy ? 'Sending' : 'Send reset link'}
            </Button>
          </form>
        ) : (
          <p className="odz-muted">Password reset is not configured for this build.</p>
        )}
        <p className="odz-muted" style={{ marginTop: '1rem' }}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </Panel>
    </PublicOnly>
  )
}
