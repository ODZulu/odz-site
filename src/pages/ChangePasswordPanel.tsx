import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Field, Panel } from '../components'
import {
  hasErrors,
  isLocked,
  loadLockout,
  minutesLeft,
  recordFailure,
  recordSuccess,
  saveLockout,
  validatePasswordChange,
  WRONG_CURRENT,
  type Lockout,
} from '../lib/password'
import { supabase } from '../lib/supabase'

type Key = 'current' | 'next' | 'confirm'
const empty = { current: '', next: '', confirm: '' }

/**
 * Change your own password (MVA-248). No email is involved. The current password is re-checked
 * with signInWithPassword using the member's own email, and only then is the new one set; a wrong
 * current password shows one generic message and changes nothing. After 5 wrong attempts the form
 * is disabled for 15 minutes in this browser (Supabase's own rate limits are the real guard). On
 * success every OTHER session is signed out; this one stays signed in. Passwords are never logged,
 * stored or sent anywhere but Supabase Auth.
 */
export function ChangePasswordPanel() {
  const { session } = useAuth()
  const email = session?.user.email ?? null
  const [values, setValues] = useState(empty)
  const [touched, setTouched] = useState<Record<Key, boolean>>({ current: false, next: false, confirm: false })
  const [shown, setShown] = useState<Record<Key, boolean>>({ current: false, next: false, confirm: false })
  const [lock, setLock] = useState<Lockout>(() => loadLockout())
  const [now, setNow] = useState(() => Date.now())
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const errors = validatePasswordChange(values)
  const locked = isLocked(lock, now)

  // While locked, re-check the clock so the form comes back on its own.
  useEffect(() => {
    if (!locked) return
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [locked])

  function setField(key: Key, value: string) {
    setValues((v) => ({ ...v, [key]: value }))
    setTouched((t) => ({ ...t, [key]: true }))
    setMessage(null)
  }

  function updateLock(next: Lockout) {
    setLock(next)
    saveLockout(next)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const at = Date.now()
    setNow(at)
    setTouched({ current: true, next: true, confirm: true })
    if (!supabase || !email || busy || isLocked(lock, at) || hasErrors(errors)) return
    setBusy(true)
    setMessage(null)
    try {
      // 1. Re-check the current password server-side with the member's own email.
      const check = await supabase.auth.signInWithPassword({ email, password: values.current })
      if (check.error) {
        if (check.error.code === 'invalid_credentials' || check.error.status === 400) {
          const next = recordFailure(lock, at)
          updateLock(next)
          setNow(at)
          setMessage({ kind: 'error', text: isLocked(next, at) ? `Too many attempts. Try again in ${minutesLeft(next, at)} minutes.` : WRONG_CURRENT })
        } else {
          setMessage({ kind: 'error', text: 'Could not check your password. Try again.' })
        }
        return
      }
      updateLock(recordSuccess())

      // 2. Set the new one.
      const change = await supabase.auth.updateUser({ password: values.next })
      if (change.error) {
        setMessage({
          kind: 'error',
          text: change.error.code === 'same_password' ? 'The new password must be different from the current one.' : 'Could not change the password. Try again.',
        })
        return
      }

      // 3. End every other session; this one stays. Then log the change (no values).
      await supabase.auth.signOut({ scope: 'others' })
      await supabase.rpc('log_password_change')
      setValues(empty)
      setTouched({ current: false, next: false, confirm: false })
      setShown({ current: false, next: false, confirm: false })
      setMessage({ kind: 'ok', text: 'Password changed. Other devices were signed out.' })
    } finally {
      setBusy(false)
    }
  }

  const field = (key: Key, label: string, autoComplete: string) => (
    <div className="odz-stack" style={{ gap: '0.375rem' }}>
      <Field
        label={label}
        type={shown[key] ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={values[key]}
        onChange={(e) => setField(key, e.target.value)}
        error={touched[key] ? errors[key] : undefined}
        disabled={locked}
        spellCheck={false}
        autoCapitalize="none"
      />
      <div>
        <Button
          type="button"
          small
          variant="ghost"
          aria-pressed={shown[key]}
          onClick={() => setShown((s) => ({ ...s, [key]: !s[key] }))}
        >
          {shown[key] ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        </Button>
      </div>
    </div>
  )

  return (
    <Panel title="Change password">
      <form onSubmit={submit} noValidate className="odz-stack">
        {field('current', 'Current password', 'current-password')}
        {field('next', 'New password', 'new-password')}
        {field('confirm', 'Confirm new password', 'new-password')}
        {locked && (
          <p role="status" className="odz-muted">
            {`Too many wrong attempts. The form is off for ${minutesLeft(lock, now)} more minutes.`}
          </p>
        )}
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} style={message.kind === 'error' ? { color: 'var(--alert)' } : undefined}>
            {message.text}
          </p>
        )}
        <div>
          <Button type="submit" disabled={busy || locked}>
            {busy ? 'Changing' : 'Change password'}
          </Button>
        </div>
      </form>
    </Panel>
  )
}
