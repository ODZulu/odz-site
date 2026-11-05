import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button, Field, Panel } from '../components'
import { clearRecovery, hasRecovery, hasResetErrors, LINK_PROBLEM_MESSAGE, RESET_DONE_NOTICE, validateReset } from '../lib/recovery'
import { supabase } from '../lib/supabase'

type Phase = 'checking' | 'ready' | 'invalid'

/**
 * Reached from the emailed link (MVA-200). Not wrapped in PublicOnly: following the link signs the
 * visitor in with a recovery session, and this page must stay put. It only works for a tab that
 * arrived through a recovery link; anyone else gets the one generic link message. Setting a
 * password never bypasses approval or removal: after saving we sign out, and the normal gates
 * decide at the next sign-in.
 */
export default function ResetPassword() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>(supabase ? 'checking' : 'invalid')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase) return
    let alive = true
    // getSession resolves after Supabase has read the link (and fired PASSWORD_RECOVERY).
    void supabase.auth.getSession().then(({ data }) => {
      if (alive) setPhase(data.session && hasRecovery() ? 'ready' : 'invalid')
    })
    return () => {
      alive = false
    }
  }, [])

  const errors = validateReset(password, confirm)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!supabase || busy || hasResetErrors(errors)) return
    setBusy(true)
    setFailed(false)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setBusy(false)
      setFailed(true)
      return
    }
    clearRecovery()
    await supabase.auth.signOut()
    navigate('/login', { replace: true, state: { notice: RESET_DONE_NOTICE } })
  }

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Set a new password
      </h1>
      <Panel title="New password">
        {phase === 'checking' && (
          <p className="odz-muted" role="status">
            Checking the link
          </p>
        )}
        {phase === 'invalid' && (
          <p role="alert">
            {LINK_PROBLEM_MESSAGE} <Link to="/forgot-password">Request a new link</Link>
          </p>
        )}
        {phase === 'ready' && (
          <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={touched ? errors.password : undefined}
            />
            <Field
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={touched ? errors.confirm : undefined}
            />
            {failed && (
              <p role="alert" style={{ color: 'var(--alert)' }}>
                {LINK_PROBLEM_MESSAGE} <Link to="/forgot-password">Request a new link</Link>
              </p>
            )}
            <Button type="submit" disabled={busy} block>
              {busy ? 'Saving' : 'Set password'}
            </Button>
          </form>
        )}
      </Panel>
    </>
  )
}
