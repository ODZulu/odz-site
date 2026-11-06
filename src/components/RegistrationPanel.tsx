import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import {
  ATTENDANCE_CHOICES,
  ATTENDANCE_LABEL,
  attendanceOpen,
  placesLine,
  registrationMessage,
  STATE_LABEL,
  validateConfig,
  windowState,
  withdrawKind,
  type Attendance,
  type ConfigForm,
  type Registrant,
  type RegistrationInfo,
} from '../lib/registration'
import { supabase } from '../lib/supabase'
import { formatStampPhoenix, fromLocalInput, toLocalInput } from '../lib/time'
import { useLoad } from '../lib/useLoad'
import { Button } from './Button'
import { ConfirmAction } from './ConfirmAction'
import { Field } from './Field'
import { Select } from './Select'

type EventLite = { id: string; title: string; starts_at: string; ends_at: string | null; status: string }

/** The event ids that use registration (they show this panel instead of RSVP and readiness). */
export async function listRegistrationEventIds(): Promise<Set<string>> {
  if (!supabase) return new Set()
  const { data, error } = await supabase.from('event_registration_settings').select('event_id')
  if (error) throw new Error('registration')
  return new Set((data as { event_id: string }[]).map((r) => r.event_id))
}

const errorStyle = { color: 'var(--alert)' } as const

/** Registration, waitlist and (for Command) settings and attendance, for one event. Members only (RLS). */
export function RegistrationToggle({ event }: { event: EventLite }) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Registration</summary>
      {open && <RegistrationPanel event={event} />}
    </details>
  )
}

export function RegistrationPanel({ event }: { event: EventLite }) {
  const { can } = useAuth()
  const write = can('write_events')
  const info = useLoad(async () => {
    const { data, error } = await supabase!.rpc('event_registration_info', { p_event: event.id })
    if (error) throw new Error('info')
    return ((data as RegistrationInfo[])[0] ?? null) as RegistrationInfo | null
  }, [event.id])
  const list = useLoad(async () => {
    const { data, error } = await supabase!.rpc('event_registrants', { p_event: event.id })
    if (error) return null // not a registrant yet: the list is not theirs to see
    return data as Registrant[]
  }, [event.id])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = new Date()

  async function call(fn: string, args: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    const { error: err } = await supabase!.rpc(fn, args)
    setBusy(false)
    if (err) {
      setError(registrationMessage(err.message))
      return false
    }
    await Promise.all([info.reload(), list.reload()])
    return true
  }

  if (info.loading) return <p className="odz-muted" role="status">Loading</p>
  if (info.failed) return <p role="alert">Could not load registration.</p>
  const i = info.data
  if (!i) return <p className="odz-muted">Registration is not used for this event.</p>

  const win = windowState(i, event, now)
  const kind = withdrawKind(i.my_state, i.withdraw_cutoff_at, now)
  const canRegister = (i.my_state === null || i.my_state === 'withdrawn') && (win === 'open' || win === 'full')
  const rows = list.data ?? []
  const requests = rows.filter((r) => r.state === 'withdrawal_requested')
  const ended = attendanceOpen(event, now)

  return (
    <div className="odz-stack" style={{ marginTop: '0.75rem' }}>
      <p>
        {placesLine(i)}.{' '}
        {win === 'not_open' && `Opens ${formatStampPhoenix(i.opens_at)}.`}
        {win === 'closed' && event.status === 'scheduled' && 'Registration is closed.'}
        {win === 'full' && 'Full: new registrations join the waitlist.'}
      </p>
      <p className="odz-muted">
        Free withdrawal until {formatStampPhoenix(i.withdraw_cutoff_at)}; after that, Command decides.
      </p>
      {i.my_state && (
        <p>
          <strong>
            You: {STATE_LABEL[i.my_state]}
            {i.my_state === 'waitlisted' && i.my_position ? ` (number ${i.my_position})` : ''}
          </strong>
        </p>
      )}
      {i.confirmed && i.my_attendance && <p>Result: {ATTENDANCE_LABEL[i.my_attendance]}</p>}
      <div className="odz-row" style={{ gap: '0.5rem' }}>
        {canRegister && (
          <Button small disabled={busy} onClick={() => void call('event_register', { p_event: event.id })}>
            {win === 'full' ? 'Join the waitlist' : 'Register'}
          </Button>
        )}
        {kind === 'withdraw' && (
          <ConfirmAction label="Withdraw" disabled={busy} onConfirm={async () => void (await call('event_withdraw', { p_event: event.id }))} />
        )}
        {kind === 'request' && (
          <ConfirmAction label="Request withdrawal" disabled={busy} onConfirm={async () => void (await call('event_withdraw', { p_event: event.id }))} />
        )}
      </div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}

      {list.data === null && <p className="odz-muted">The list of registrants is shown to registrants and to Old Guard and Command.</p>}
      {rows.length > 0 && (
        <div>
          <p className="odz-label">Registrants</p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {rows.map((r) => (
              <li key={r.profile_id}>
                {r.callsign ?? 'Unknown'}: {STATE_LABEL[r.state]}
                {r.waitlist_position ? ` (number ${r.waitlist_position})` : ''}
                {r.walk_in ? ' (walk-in)' : ''}
                {r.attendance ? `, ${ATTENDANCE_LABEL[r.attendance]}` : ''}
                {' · '}
                {formatStampPhoenix(r.registered_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {i.no_show_count !== null && i.excused_count !== null && (i.no_show_count > 0 || i.excused_count > 0) && (
        <p className="odz-muted">
          {i.no_show_count} no-show, {i.excused_count} excused.
        </p>
      )}

      {write && (
        <>
          {requests.length > 0 && (
            <div>
              <p className="odz-label">Withdrawal requests</p>
              {requests.map((r) => (
                <div key={r.profile_id} className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span>{r.callsign ?? 'Unknown'}</span>
                  <Button small variant="sec" disabled={busy} onClick={() => void call('event_withdrawal_decide', { p_event: event.id, p_member: r.profile_id, p_approve: true, p_note: null })}>
                    Approve
                  </Button>
                  <Button small variant="sec" disabled={busy} onClick={() => void call('event_withdrawal_decide', { p_event: event.id, p_member: r.profile_id, p_approve: false, p_note: null })}>
                    Decline
                  </Button>
                </div>
              ))}
            </div>
          )}
          <MemberAction
            title="Register a member (override)"
            action="Register"
            hint="Ignores the window and capacity. The reason is logged."
            busy={busy}
            onSubmit={(member, reason) => call('event_register_member', { p_event: event.id, p_member: member, p_reason: reason })}
          />
          <Settings event={event} info={i} onDone={() => void Promise.all([info.reload(), list.reload()])} />
          {ended && (
            <AttendanceSection
              event={event}
              info={i}
              rows={rows}
              busy={busy}
              call={call}
            />
          )}
        </>
      )}
    </div>
  )
}

function Settings({ event, info, onDone }: { event: EventLite; info: RegistrationInfo; onDone: () => void }) {
  const [form, setForm] = useState<ConfigForm>({
    opens: toLocalInput(info.opens_at),
    closes: info.closes_at ? toLocalInput(info.closes_at) : '',
    capacity: info.capacity === null ? '' : String(info.capacity),
    cutoff: toLocalInput(info.withdraw_cutoff_at),
  })
  const [errors, setErrors] = useState<Partial<Record<keyof ConfigForm, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof ConfigForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  async function save() {
    const found = validateConfig(form, event.starts_at, fromLocalInput)
    setErrors(found)
    setError(null)
    if (Object.keys(found).length > 0) return
    const { error: err } = await supabase!.rpc('event_registration_configure', {
      p_event: event.id,
      p_opens_at: form.opens ? fromLocalInput(form.opens) : null,
      p_closes_at: form.closes ? fromLocalInput(form.closes) : null,
      p_capacity: form.capacity.trim() === '' ? null : Number(form.capacity),
      p_cutoff_at: form.cutoff ? fromLocalInput(form.cutoff) : null,
    })
    if (err) return setError(registrationMessage(err.message))
    onDone()
  }

  return (
    <details>
      <summary>Registration settings</summary>
      <div className="odz-stack" style={{ marginTop: '0.5rem' }}>
        <Field label="Opens (Phoenix time)" type="datetime-local" value={form.opens} onChange={set('opens')} error={errors.opens} />
        <Field label="Closes (optional)" type="datetime-local" value={form.closes} onChange={set('closes')} error={errors.closes} />
        <Field label="Capacity (empty for no limit)" inputMode="numeric" value={form.capacity} onChange={set('capacity')} error={errors.capacity} />
        <Field label="Free withdrawal until" type="datetime-local" value={form.cutoff} onChange={set('cutoff')} error={errors.cutoff} />
        {error && <p role="alert" style={errorStyle}>{error}</p>}
        <Button small variant="sec" onClick={() => void save()}>
          Save settings
        </Button>
      </div>
    </details>
  )
}

type Profile = { id: string; callsign: string }

/** A member picker plus a required reason; used for the registration override and for walk-ins. */
function MemberAction({
  title, action, hint, busy, onSubmit,
}: {
  title: string
  action: string
  hint: string
  busy: boolean
  onSubmit: (member: string, reason: string) => Promise<boolean>
}) {
  const members = useLoad(async () => {
    const { data } = await supabase!.from('profiles').select('id,callsign').eq('status', 'approved').order('callsign')
    return (data ?? []) as Profile[]
  })
  const [member, setMember] = useState('')
  const [reason, setReason] = useState('')
  return (
    <details>
      <summary>{title}</summary>
      <div className="odz-stack" style={{ marginTop: '0.5rem' }}>
        <Select
          label="Member"
          value={member}
          onChange={(e) => setMember(e.target.value)}
          options={[{ value: '', label: 'Choose a member' }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.callsign }))]}
        />
        <Field label="Reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint={hint} />
        <Button
          small
          variant="sec"
          disabled={busy || member === '' || reason.trim().length < 3}
          onClick={async () => {
            if (await onSubmit(member, reason.trim())) {
              setMember('')
              setReason('')
            }
          }}
        >
          {action}
        </Button>
      </div>
    </details>
  )
}

function AttendanceSection({
  event, info, rows, busy, call,
}: {
  event: EventLite
  info: RegistrationInfo
  rows: Registrant[]
  busy: boolean
  call: (fn: string, args: Record<string, unknown>) => Promise<boolean>
}) {
  const [reason, setReason] = useState('')
  const marking = rows.filter((r) => (r.state === 'registered' || r.state === 'withdrawal_requested') && !r.walk_in)
  const walkIns = rows.filter((r) => r.walk_in)
  const mark = (member: string, result: Attendance) =>
    call('event_attendance_set', { p_event: event.id, p_member: member, p_result: result, p_reason: reason.trim() || null })

  return (
    <div className="odz-stack">
      <p className="odz-label">Attendance</p>
      {info.confirmed ? (
        <>
          <p className="odz-muted">Confirmed. A change needs a reason and is logged.</p>
          <Field label="Reason for a change" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </>
      ) : (
        <p className="odz-muted">{info.unmarked_count ?? 0} not marked yet. Confirming needs every registrant marked and completes the event.</p>
      )}
      {[...marking, ...walkIns].map((r) => (
        <div key={r.profile_id} className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <span>{r.callsign ?? 'Unknown'}</span>
          {ATTENDANCE_CHOICES.map((a) => (
            <Button key={a} small variant={r.attendance === a ? 'primary' : 'sec'} disabled={busy} aria-pressed={r.attendance === a} onClick={() => void mark(r.profile_id, a)}>
              {ATTENDANCE_LABEL[a]}
            </Button>
          ))}
        </div>
      ))}
      <MemberAction
        title="Add a walk-in"
        action="Add as attended"
        hint="Someone who came without registering. The reason is logged."
        busy={busy}
        onSubmit={(member, why) => call('event_attendance_walkin', { p_event: event.id, p_member: member, p_reason: why })}
      />
      {!info.confirmed && (
        <ConfirmAction
          label="Confirm attendance"
          confirmLabel="Yes, confirm attendance"
          small={false}
          variant="primary"
          disabled={busy}
          onConfirm={async () => void (await call('event_attendance_confirm', { p_event: event.id }))}
        />
      )}
    </div>
  )
}
