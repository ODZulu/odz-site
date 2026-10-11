import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { PublicOnly } from '../auth/Gate'
import { Button, Field, Panel } from '../components'
import { supabase } from '../lib/supabase'
import { inviteCodeShapeOk, normalizeInviteCode, PASSWORD_MIN, validateEmail, validatePassword } from '../lib/validate'

/**
 * Invite-only signup (`/join` or `/join/:code`). Not linked from any public page and never
 * described anywhere: the only way here is an invite link. A bad code gets one generic answer
 * whatever the reason (unknown, used, revoked, expired, locked out).
 */
const NOT_VALID = 'Invite not valid.'

export default function Join() {
  const { code: fromLink } = useParams()
  const [code, setCode] = useState(fromLink ?? '')
  const [step, setStep] = useState<'code' | 'account' | 'created'>('code')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ code?: string; email?: string; password?: string; confirm?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  async function checkCode(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return setErrors({ code: 'Sign-up is not available.' })
    if (!inviteCodeShapeOk(code)) return setErrors({ code: NOT_VALID })
    setBusy(true)
    const { data, error } = await supabase.rpc('check_invite', { p_code: normalizeInviteCode(code) })
    setBusy(false)
    if (error) return setErrors({ code: 'Could not check the invite. Try again.' })
    if (data !== true) return setErrors({ code: NOT_VALID })
    setErrors({})
    setStep('account')
  }

  async function createAccount(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const next = {
      email: validateEmail(email) ?? undefined,
      password: validatePassword(password) ?? undefined,
      confirm: password === confirm ? undefined : 'Passwords do not match.',
    }
    if (next.email || next.password || next.confirm) return setErrors(next)
    setBusy(true)
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { invite_code: normalizeInviteCode(code) } },
    })
    setBusy(false)
    if (error) return setErrors({ form: 'Could not create the account. Check your details and try again.' })
    setErrors({})
    // With email confirmation off there is a session and the auth provider sends the new account
    // to account setup. Without one, the user signs in normally.
    if (!data.session) setStep('created')
  }

  return (
    <PublicOnly>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Join
      </h1>
      {step === 'code' && (
        <Panel title="Invite code">
          <form onSubmit={checkCode} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field
              label="Invite code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={errors.code}
            />
            <Button type="submit" disabled={busy} block>
              {busy ? 'Checking' : 'Continue'}
            </Button>
          </form>
        </Panel>
      )}
      {step === 'account' && (
        <Panel title="Create your account">
          <form onSubmit={createAccount} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="new-password"
              hint={`At least ${PASSWORD_MIN} characters.`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
            />
            <Field
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={errors.confirm}
            />
            {errors.form && (
              <p role="alert" style={{ color: 'var(--alert)' }}>
                {errors.form}
              </p>
            )}
            <Button type="submit" disabled={busy} block>
              {busy ? 'Creating' : 'Create account'}
            </Button>
          </form>
        </Panel>
      )}
      {step === 'created' && (
        <Panel title="Account created">
          <p>
            Your account was created. <Link to="/login">Sign in</Link> to continue.
          </p>
        </Panel>
      )}
    </PublicOnly>
  )
}
