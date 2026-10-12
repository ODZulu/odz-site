import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Field, Panel } from '../components'
import { formatPhoneInput, normalizeAllergies, normalizePhone } from '../lib/phone'
import { supabase } from '../lib/supabase'
import { setupErrorField, validateSetup, type SetupErrors, type SetupValues } from '../lib/validate'

const empty: SetupValues = {
  callsign: '',
  legalName: '',
  dob: '',
  phone: '',
  allergies: '',
  emergencyName: '',
  emergencyRelationship: '',
  emergencyPhone: '',
}

/**
 * One-time account setup, shown right after the first sign-in. The app is unusable until it is
 * complete (see lib/access.ts). Values go straight to the complete_setup() RPC and are never
 * logged, put in a URL, stored in the browser, or echoed back in an error message.
 */
export default function Setup() {
  const { refreshProfile } = useAuth()
  const [v, setV] = useState<SetupValues>(empty)
  const [errors, setErrors] = useState<SetupErrors & { form?: string }>({})
  const [busy, setBusy] = useState(false)
  const today = new Date()
  const max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const bind = (k: keyof SetupValues) => ({
    value: v[k],
    onChange: (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value })),
    error: errors[k],
  })

  const bindPhone = (k: 'phone' | 'emergencyPhone') => ({
    ...bind(k),
    onChange: (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: formatPhoneInput(e.target.value) })),
    inputMode: 'tel' as const,
    placeholder: '555-010-0100',
  })

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const found = validateSetup(v)
    if (Object.keys(found).length > 0) return setErrors(found)
    setBusy(true)
    const { error } = await supabase.rpc('complete_setup', {
      p_callsign: v.callsign.trim(),
      p_legal_name: v.legalName.trim(),
      p_dob: v.dob,
      p_phone: normalizePhone(v.phone),
      p_allergies: normalizeAllergies(v.allergies),
      p_emergency_name: v.emergencyName.trim(),
      p_emergency_relationship: v.emergencyRelationship.trim(),
      p_emergency_phone: normalizePhone(v.emergencyPhone) ?? '',
    })
    if (!error) {
      await refreshProfile() // the gate then moves the account on
      return
    }
    setBusy(false)
    // Only the fixed code is used. error.details and the rest are never shown or logged.
    const field = setupErrorField[error.message]
    setErrors(
      field
        ? { [field]: error.message === 'callsign_taken' ? 'That callsign is taken.' : 'Check this field.' }
        : { form: 'Could not save. Try again.' },
    )
  }

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Account setup
      </h1>
      <Panel title="Before you start">
        <p>
          This information is kept private. Only you, Command and Admin can see it. It is used for event safety and
          team purchases such as tickets. To correct or delete anything, ask Command.
        </p>
      </Panel>
      <form
        onSubmit={onSubmit}
        noValidate
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}
      >
        <Field label="Callsign" autoComplete="off" hint="Your handle. 2 to 24 characters." {...bind('callsign')} />
        <Field label="Full legal name" autoComplete="name" {...bind('legalName')} />
        <Field label="Date of birth" type="date" max={max} autoComplete="bday" {...bind('dob')} />
        <Field label="Mobile phone (optional)" type="tel" autoComplete="tel" {...bindPhone('phone')} />
        <Field
          label="Allergies"
          autoComplete="off"
          hint="Allergies only. Enter NKA if none (No Known Allergies)."
          placeholder="NKA"
          {...bind('allergies')}
        />
        <Field label="Emergency contact name" autoComplete="off" {...bind('emergencyName')} />
        <Field label="Emergency contact relationship" autoComplete="off" {...bind('emergencyRelationship')} />
        <Field label="Emergency contact phone" type="tel" autoComplete="off" {...bindPhone('emergencyPhone')} />
        {errors.form && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {errors.form}
          </p>
        )}
        <Button type="submit" disabled={busy} block>
          {busy ? 'Saving' : 'Save and continue'}
        </Button>
      </form>
    </>
  )
}
