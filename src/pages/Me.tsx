import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, Field, Panel, Textarea } from '../components'
import {
  BIO_MAX,
  counter,
  NAME_MAX,
  profileErrorField,
  ROLE_MAX,
  validateOwnProfile,
  type OwnProfileErrors,
  type OwnProfileValues,
} from '../lib/roster'
import { supabase } from '../lib/supabase'
import { setupErrorField, validatePrivate, type PrivateErrors, type PrivateValues } from '../lib/validate'
import { useLoad } from '../lib/useLoad'

type OwnRow = { callsign: string | null; display_name: string | null; role_note: string | null; bio: string | null }
type PrivateRow = {
  legal_name: string
  dob: string
  phone: string | null
  allergies: string
  emergency_name: string
  emergency_relationship: string
  emergency_phone: string
}

const blankPrivate: PrivateValues = {
  legalName: '',
  dob: '',
  phone: '',
  allergies: '',
  emergencyName: '',
  emergencyRelationship: '',
  emergencyPhone: '',
}

/** /me: edit your own team-visible profile, and your own private details. Tier and status are read-only. */
export default function Me() {
  const { session, tierName } = useAuth()
  const uid = session?.user.id
  const own = useLoad<OwnRow | null>(async () => {
    const { data, error } = await supabase!.from('profiles').select('callsign,display_name,role_note,bio').eq('id', uid!).maybeSingle()
    if (error) throw new Error('me')
    return data as OwnRow | null
  }, [uid])

  const [values, setValues] = useState<OwnProfileValues>({ display_name: '', role_note: '', bio: '' })
  const [errors, setErrors] = useState<OwnProfileErrors & { form?: string }>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (own.data) {
      setValues({ display_name: own.data.display_name ?? '', role_note: own.data.role_note ?? '', bio: own.data.bio ?? '' })
    }
  }, [own.data])

  async function saveProfile(e: FormEvent) {
    e.preventDefault()
    const found = validateOwnProfile(values)
    setErrors(found)
    setSaved(false)
    if (Object.keys(found).length > 0 || !supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('update_own_profile', {
      p_display_name: values.display_name,
      p_role_note: values.role_note,
      p_bio: values.bio,
    })
    setBusy(false)
    if (error) {
      const field = profileErrorField[error.message]
      setErrors(field ? { [field]: 'Too long.' } : { form: 'Could not save. Try again.' })
      return
    }
    setSaved(true)
    void own.reload()
  }

  const bind = (k: keyof OwnProfileValues) => ({
    value: values[k],
    onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value })),
    error: errors[k],
  })

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        My profile
      </h1>
      <div className="odz-stack">
        <Panel title="Team-visible" action={<Chip variant="plain">{own.data?.callsign ?? ''}</Chip>}>
          <p className="odz-muted" style={{ marginBottom: '1rem' }}>
            Other members see these. Tier{tierName ? ` (${tierName})` : ''} and callsign are set by Command.
          </p>
          <form onSubmit={saveProfile} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Display name" maxLength={NAME_MAX} hint={counter(values.display_name, NAME_MAX)} {...bind('display_name')} />
            <Field label="Role note" maxLength={ROLE_MAX} hint={`For example Medic or Comms. ${counter(values.role_note, ROLE_MAX)}`} {...bind('role_note')} />
            <Textarea label="Bio" maxLength={BIO_MAX} hint={`Plain text. ${counter(values.bio, BIO_MAX)}`} {...bind('bio')} />
            {errors.form && (
              <p role="alert" style={{ color: 'var(--alert)' }}>
                {errors.form}
              </p>
            )}
            <div className="odz-row">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving' : 'Save profile'}
              </Button>
              {saved && <span role="status">Saved.</span>}
            </div>
          </form>
        </Panel>
        <PrivateDetails uid={uid} />
      </div>
    </>
  )
}

function PrivateDetails({ uid }: { uid: string | undefined }) {
  const row = useLoad<PrivateRow | null>(async () => {
    const { data, error } = await supabase!
      .from('member_private')
      .select('legal_name,dob,phone,allergies,emergency_name,emergency_relationship,emergency_phone')
      .eq('profile_id', uid!)
      .maybeSingle()
    if (error) throw new Error('private')
    return data as PrivateRow | null
  }, [uid])
  const [v, setV] = useState<PrivateValues>(blankPrivate)
  const [errors, setErrors] = useState<PrivateErrors & { form?: string }>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (row.data) {
      setV({
        legalName: row.data.legal_name,
        dob: row.data.dob,
        phone: row.data.phone ?? '',
        allergies: row.data.allergies,
        emergencyName: row.data.emergency_name,
        emergencyRelationship: row.data.emergency_relationship,
        emergencyPhone: row.data.emergency_phone,
      })
    }
  }, [row.data])

  const bind = (k: keyof PrivateValues) => ({
    value: v[k],
    onChange: (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value })),
    error: errors[k],
  })

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaved(false)
    const found = validatePrivate(v)
    setErrors(found)
    if (Object.keys(found).length > 0 || !supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('update_own_private', {
      p_legal_name: v.legalName.trim(),
      p_dob: v.dob,
      p_phone: v.phone.trim() || null,
      p_allergies: v.allergies.trim(),
      p_emergency_name: v.emergencyName.trim(),
      p_emergency_relationship: v.emergencyRelationship.trim(),
      p_emergency_phone: v.emergencyPhone.trim(),
    })
    setBusy(false)
    if (error) {
      // Only the fixed code is used; nothing from the error is shown or logged.
      const field = setupErrorField[error.message]
      setErrors(field && field !== 'callsign' ? { [field]: 'Check this field.' } : { form: 'Could not save. Try again.' })
      return
    }
    setSaved(true)
    void row.reload()
  }

  return (
    <Panel title="My private details" action={<Chip variant="pending">PRIVATE</Chip>}>
      <p className="odz-muted" style={{ marginBottom: '1rem' }}>
        Only you, Command and Admin can see these. They are used for event safety and team purchases. To delete anything,
        ask Command.
      </p>
      {row.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : row.failed ? (
        <p role="alert">Could not load.</p>
      ) : !row.data ? (
        <p className="odz-muted">No private details on file.</p>
      ) : (
        <form onSubmit={save} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Field label="Full legal name" autoComplete="off" {...bind('legalName')} />
          <Field label="Date of birth" type="date" autoComplete="off" {...bind('dob')} />
          <Field label="Mobile phone (optional)" type="tel" autoComplete="off" {...bind('phone')} />
          <Field label="Allergies" autoComplete="off" hint='Allergies only. Write "None" if you have none.' {...bind('allergies')} />
          <Field label="Emergency contact name" autoComplete="off" {...bind('emergencyName')} />
          <Field label="Emergency contact relationship" autoComplete="off" {...bind('emergencyRelationship')} />
          <Field label="Emergency contact phone" type="tel" autoComplete="off" {...bind('emergencyPhone')} />
          {errors.form && (
            <p role="alert" style={{ color: 'var(--alert)' }}>
              {errors.form}
            </p>
          )}
          <div className="odz-row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving' : 'Save private details'}
            </Button>
            {saved && <span role="status">Saved.</span>}
          </div>
        </form>
      )}
    </Panel>
  )
}
