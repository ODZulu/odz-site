import { useState } from 'react'
import { Button } from './Button'
import { ConfirmAction } from './ConfirmAction'
import { Field } from './Field'
import { Panel } from './Panel'
import { Select } from './Select'
import { Textarea } from './Textarea'
import {
  ACTION_LABEL,
  cadenceMessage,
  emptyStep,
  emptyTemplateForm,
  hasTemplateErrors,
  summarisePlan,
  toStepsJson,
  toTemplateForm,
  validateTemplate,
  type CadenceStep,
  type CadenceTemplate,
  type PlanRow,
  type TemplateErrors,
  type TemplateForm,
} from '../lib/cadence'
import { EVENT_TYPES } from '../lib/events'
import { AUDIENCE_LABEL, AUDIENCES, type Audience } from '../lib/recurrence'
import { supabase } from '../lib/supabase'
import { formatDateLine, formatTimeL } from '../lib/time'
import { useLoad } from '../lib/useLoad'

const err = { color: 'var(--alert)' } as const

type TemplateRow = Omit<CadenceTemplate, 'steps'>

async function loadTemplates(): Promise<CadenceTemplate[]> {
  const t = await supabase!.from('event_cadence_templates').select('id,name,event_type,auto_apply,timezone,status').order('name')
  const s = await supabase!.from('event_cadence_steps').select('id,template_id,position,title,offset_days,local_time,duration_minutes,audience,topics').order('position')
  if (t.error || s.error) throw new Error('cadence')
  const steps = (s.data ?? []) as (CadenceStep & { template_id: string })[]
  return ((t.data ?? []) as TemplateRow[]).map((row) => ({ ...row, steps: steps.filter((x) => x.template_id === row.id) }))
}

/** Prep cadence templates (MVA-229): Command and Admin (write_events) only. */
export function CadencePanel({ onChanged }: { onChanged: () => void }) {
  const list = useLoad(loadTemplates)
  const [editing, setEditing] = useState<'new' | CadenceTemplate | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  async function retire(id: string, retired: boolean) {
    setFailure(null)
    const { error } = await supabase!.rpc('event_cadence_template_retire', { p_id: id, p_retired: retired })
    if (error) return setFailure(cadenceMessage(error.message))
    await list.reload()
    onChanged()
  }

  return (
    <Panel title="Prep cadences">
      <div className="odz-stack">
        <p className="odz-muted">A rhythm of prep meetings counted back from an event, defined once. Apply it to any event from that event&apos;s card, or let it apply itself to every new event of a type.</p>
        {failure && <p role="alert" style={err}>{failure}</p>}
        {editing === null && (
          <Button small variant="sec" onClick={() => setEditing('new')}>
            New prep cadence
          </Button>
        )}
        {editing !== null && (
          <TemplateEditor
            existing={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onDone={async () => {
              setEditing(null)
              await list.reload()
              onChanged()
            }}
          />
        )}
        {list.loading ? (
          <p className="odz-muted" role="status">Loading</p>
        ) : list.failed ? (
          <p role="alert">Could not load the prep cadences.</p>
        ) : (list.data ?? []).length === 0 ? (
          <p className="odz-muted">No prep cadences yet.</p>
        ) : (
          <ul className="odz-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(list.data ?? []).map((t) => (
              <li key={t.id} className="odz-panel" style={{ padding: '0.75rem 1rem' }}>
                <strong>{t.name}</strong> {t.status === 'retired' && <span className="odz-muted">(retired)</span>}
                <p className="odz-muted">
                  {t.event_type ? `For ${t.event_type} events` : 'Any event type'}
                  {t.auto_apply ? ', applied automatically' : ''} · {t.steps.length} step{t.steps.length === 1 ? '' : 's'}
                </p>
                <ol style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
                  {t.steps.map((s) => (
                    <li key={s.id}>
                      {s.offset_days} days before, {s.local_time.slice(0, 5)}: {s.title} ({AUDIENCE_LABEL[s.audience]})
                    </li>
                  ))}
                </ol>
                <div className="odz-row" style={{ gap: '0.5rem' }}>
                  {t.status === 'active' ? (
                    <>
                      <Button small variant="sec" onClick={() => setEditing(t)}>
                        Edit
                      </Button>
                      <ConfirmAction label="Retire" confirmLabel="Confirm retire" onConfirm={() => retire(t.id, true)} />
                    </>
                  ) : (
                    <Button small variant="sec" onClick={() => void retire(t.id, false)}>
                      Restore
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}

function TemplateEditor({ existing, onDone, onCancel }: { existing: CadenceTemplate | null; onDone: () => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<TemplateForm>(existing ? toTemplateForm(existing) : emptyTemplateForm())
  const [errors, setErrors] = useState<TemplateErrors>({})
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const setStep = (i: number, patch: Partial<TemplateForm['steps'][number]>) =>
    setForm({ ...form, steps: form.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  async function submit() {
    const found = validateTemplate(form)
    setErrors(found)
    setFailed(null)
    if (hasTemplateErrors(found)) return
    setBusy(true)
    const { error } = await supabase!.rpc('event_cadence_template_save', {
      p_id: existing?.id ?? null,
      p_name: form.name.trim(),
      p_event_type: form.event_type || null,
      p_auto: form.auto_apply,
      p_timezone: existing?.timezone ?? 'America/Phoenix',
      p_steps: toStepsJson(form.steps),
    })
    setBusy(false)
    if (error) return setFailed(cadenceMessage(error.message))
    await onDone()
  }

  return (
    <div className="odz-stack">
      <Field label="Template name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} />
      <Select
        label="Applies to"
        value={form.event_type}
        onChange={(e) => setForm({ ...form, event_type: e.target.value, auto_apply: e.target.value === '' ? false : form.auto_apply })}
        options={[{ value: '', label: 'Any event type (apply by hand)' }, ...EVENT_TYPES.map((t) => ({ value: t, label: t }))]}
      />
      <label className="odz-row" style={{ gap: '0.5rem', minHeight: '2.5rem' }}>
        <input type="checkbox" checked={form.auto_apply} disabled={form.event_type === ''} onChange={(e) => setForm({ ...form, auto_apply: e.target.checked })} />
        Apply automatically to every new event of this type
      </label>
      {errors.auto_apply && <p role="alert" style={err}>{errors.auto_apply}</p>}
      {errors.steps && <p role="alert" style={err}>{errors.steps}</p>}
      {form.steps.map((s, i) => (
        <fieldset key={i} className="odz-panel" style={{ padding: '0.75rem 1rem', margin: 0 }}>
          <legend className="odz-label">Step {i + 1}</legend>
          <div className="odz-stack">
            <Field label="Title" value={s.title} maxLength={80} onChange={(e) => setStep(i, { title: e.target.value })} />
            <Field label="Days before the event" inputMode="numeric" value={s.offset_days} onChange={(e) => setStep(i, { offset_days: e.target.value })} />
            <Field label="Time of day (Phoenix)" type="time" value={s.local_time} onChange={(e) => setStep(i, { local_time: e.target.value })} />
            <Field label="Duration (minutes)" inputMode="numeric" value={s.duration_minutes} onChange={(e) => setStep(i, { duration_minutes: e.target.value })} />
            <Select label="Who it is for" value={s.audience} onChange={(e) => setStep(i, { audience: e.target.value as Audience })} options={AUDIENCES.map((a) => ({ value: a, label: AUDIENCE_LABEL[a] }))} />
            <Textarea label="Agenda topics" value={s.topics} maxLength={2000} onChange={(e) => setStep(i, { topics: e.target.value })} hint="Becomes the meeting's description." />
            {errors.step?.[i] && <p role="alert" style={err}>{errors.step[i]}</p>}
            {form.steps.length > 1 && (
              <Button small variant="ghost" onClick={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}>
                Remove this step
              </Button>
            )}
          </div>
        </fieldset>
      ))}
      <Button small variant="sec" onClick={() => setForm({ ...form, steps: [...form.steps, emptyStep()] })}>
        Add a step
      </Button>
      {existing && <p className="odz-muted">Saving does not change meetings already created from this template. Use Apply prep cadence on an event to re-apply it.</p>}
      {failed && <p role="alert" style={err}>{failed}</p>}
      <div className="odz-row">
        <Button variant="accent" disabled={busy} onClick={() => void submit()}>
          Save template
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    </div>
  )
}

/** On an event card: pick a template, see exactly what would happen, then apply (or re-apply). */
export function ApplyCadence({ eventId, onDone }: { eventId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Button small variant="sec" onClick={() => setOpen(true)}>
        Apply prep cadence
      </Button>
    )
  }
  return <ApplyCadenceOpen eventId={eventId} onDone={onDone} onClose={() => setOpen(false)} />
}

// Templates are read only once the picker is opened, so a calendar full of events does not fetch them per card.
function ApplyCadenceOpen({ eventId, onDone, onClose }: { eventId: string; onDone: () => void; onClose: () => void }) {
  const templates = useLoad(loadTemplates)
  const [templateId, setTemplateId] = useState('')
  const [plan, setPlan] = useState<PlanRow[] | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = (templates.data ?? []).filter((t) => t.status === 'active')

  async function preview(id: string) {
    setTemplateId(id)
    setPlan(null)
    setResult(null)
    setError(null)
    if (id === '') return
    const { data, error: err2 } = await supabase!.rpc('event_cadence_plan', { p_event: eventId, p_template: id })
    if (err2) return setError(cadenceMessage(err2.message))
    setPlan(data as PlanRow[])
  }

  async function apply() {
    setBusy(true)
    setError(null)
    const { data, error: err2 } = await supabase!.rpc('event_cadence_apply', { p_event: eventId, p_template: templateId })
    setBusy(false)
    if (err2) return setError(cadenceMessage(err2.message))
    const s = summarisePlan(data as { step_title: string; action: PlanRow['action'] }[])
    setResult(
      `Created ${s.create}, updated ${s.update}.` +
        (s.skipped.length ? ` Skipped (date already passed): ${s.skipped.join(', ')}.` : '') +
        (s.edited.length ? ` Left alone (edited by hand): ${s.edited.join(', ')}.` : ''),
    )
    setPlan(null)
    onDone()
  }

  const actionable = (plan ?? []).some((p) => p.action === 'create' || p.action === 'update')

  return (
    <div className="odz-stack" style={{ marginTop: '0.5rem', width: '100%' }}>
      <Select
        label="Prep cadence"
        value={templateId}
        onChange={(e) => void preview(e.target.value)}
        options={[{ value: '', label: 'Choose a template' }, ...active.map((t) => ({ value: t.id, label: t.name }))]}
      />
      {plan && (
        <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {plan.map((p) => (
            <li key={p.step_id}>
              {p.step_title}: {formatDateLine(p.new_starts_at)} {formatTimeL(p.new_starts_at)} · {ACTION_LABEL[p.action]}
            </li>
          ))}
        </ol>
      )}
      {error && <p role="alert" style={err}>{error}</p>}
      {result && <p role="status">{result}</p>}
      <div className="odz-row">
        <Button small variant="primary" disabled={busy || !actionable} onClick={() => void apply()}>
          Apply
        </Button>
        <Button small variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}
