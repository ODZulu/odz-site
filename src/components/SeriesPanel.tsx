import { useState } from 'react'
import { Button } from './Button'
import { ConfirmAction } from './ConfirmAction'
import { Field } from './Field'
import { Panel } from './Panel'
import { Select } from './Select'
import { Textarea } from './Textarea'
import { EVENT_TYPES } from '../lib/events'
import {
  AUDIENCE_LABEL,
  AUDIENCES,
  describeRule,
  emptySeriesForm,
  expandOccurrences,
  seriesMessage,
  toCreateArgs,
  validateSeries,
  type Audience,
  type Series,
  type SeriesErrors,
  type SeriesForm,
} from '../lib/recurrence'
import { supabase } from '../lib/supabase'
import { formatDateLine, formatTimeL } from '../lib/time'
import { useLoad } from '../lib/useLoad'

const TEAM_TIMEZONE = 'America/Phoenix' // the team setting; each series stores its own
const err = { color: 'var(--alert)' } as const

/** Standing meetings (MVA-228): create, edit and cancel recurring series. For write_events holders. */
export function SeriesPanel({ onChanged }: { onChanged: () => void }) {
  const list = useLoad(async () => {
    const { data, error } = await supabase!.rpc('event_series_list')
    if (error) throw new Error('series')
    return data as Series[]
  })
  const [mode, setMode] = useState<'none' | 'new' | Series>('none')
  const [failure, setFailure] = useState<string | null>(null)

  async function cancel(id: string) {
    setFailure(null)
    const { error } = await supabase!.rpc('event_series_cancel', { p_series: id })
    if (error) return setFailure(seriesMessage(error.message))
    await list.reload()
    onChanged()
  }

  return (
    <Panel title="Standing meetings">
      <div className="odz-stack">
        <p className="odz-muted">Meetings that repeat on a schedule. The next 90 days are kept filled in automatically, and each meeting is an ordinary event.</p>
        {failure && <p role="alert" style={err}>{failure}</p>}
        {mode === 'none' && (
          <Button small variant="sec" onClick={() => setMode('new')}>
            New standing meeting
          </Button>
        )}
        {mode !== 'none' && (
          <SeriesForm
            existing={mode === 'new' ? null : mode}
            onCancel={() => setMode('none')}
            onDone={async () => {
              setMode('none')
              await list.reload()
              onChanged()
            }}
          />
        )}
        {list.loading ? (
          <p className="odz-muted" role="status">Loading</p>
        ) : list.failed ? (
          <p role="alert">Could not load the standing meetings.</p>
        ) : (list.data ?? []).length === 0 ? (
          <p className="odz-muted">No standing meetings yet.</p>
        ) : (
          <ul className="odz-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(list.data ?? []).map((s) => (
              <li key={s.id} className="odz-panel" style={{ padding: '0.75rem 1rem' }}>
                <strong>{s.title}</strong> {s.status === 'cancelled' && <span className="odz-muted">(cancelled)</span>}
                <p>{describeRule(s)} at {s.start_time.slice(0, 5)} ({s.timezone}), {s.duration_minutes} min</p>
                <p className="odz-muted">
                  For: {AUDIENCE_LABEL[s.audience]}
                  {s.status === 'active' && ` · Next: ${s.next_starts_at ? `${formatDateLine(s.next_starts_at)} ${formatTimeL(s.next_starts_at)}` : 'none in the next 90 days'}`}
                </p>
                {s.status === 'active' && (
                  <div className="odz-row" style={{ gap: '0.5rem' }}>
                    <Button small variant="sec" onClick={() => setMode(s)}>
                      Edit
                    </Button>
                    <ConfirmAction label="Cancel series" confirmLabel="Confirm: cancel all future meetings" onConfirm={() => cancel(s.id)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}

function SeriesForm({ existing, onDone, onCancel }: { existing: Series | null; onDone: () => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<SeriesForm>(
    existing
      ? {
          ...emptySeriesForm,
          title: existing.title,
          event_type: existing.event_type,
          audience: existing.audience,
          first_date: existing.first_date,
          start_time: existing.start_time.slice(0, 5),
          duration_minutes: String(existing.duration_minutes),
          rule: existing.rule,
          interval_weeks: String(existing.interval_weeks),
          nth: existing.nth === null ? '2' : String(existing.nth),
          until_date: existing.until_date ?? '',
          max_count: existing.max_count === null ? '' : String(existing.max_count),
          location_name: existing.location_name ?? '',
          description: existing.description ?? '',
        }
      : emptySeriesForm,
  )
  const [fromDate, setFromDate] = useState('')
  const [errors, setErrors] = useState<SeriesErrors>({})
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof SeriesForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const found = validateSeries(form)
  const today = new Date().toISOString().slice(0, 10)
  const preview =
    Object.keys(found).length === 0
      ? expandOccurrences(
          { rule: form.rule, first_date: form.first_date, interval_weeks: Number(form.interval_weeks) || 1, nth: Number(form.nth) || null, until_date: form.until_date || null, max_count: form.max_count ? Number(form.max_count) : null },
          today,
        ).slice(0, 4)
      : []

  async function submit() {
    setErrors(found)
    setFailed(null)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    const args = toCreateArgs(form, existing?.timezone ?? TEAM_TIMEZONE)
    const { error } = existing
      ? await supabase!.rpc('event_series_update', {
          p_series: existing.id, p_title: args.p_title, p_event_type: args.p_event_type, p_audience: args.p_audience,
          p_start_time: args.p_start_time, p_duration_minutes: args.p_duration_minutes, p_timezone: args.p_timezone,
          p_until: args.p_until, p_max_count: args.p_max_count, p_location_name: args.p_location_name,
          p_description: args.p_description, p_from_date: fromDate || null,
        })
      : await supabase!.rpc('event_series_create', args)
    setBusy(false)
    if (error) return setFailed(seriesMessage(error.message))
    await onDone()
  }

  return (
    <div className="odz-stack">
      <Field label="Title" value={form.title} maxLength={120} onChange={set('title')} error={errors.title} />
      <Select label="Type" value={form.event_type} onChange={set('event_type')} options={EVENT_TYPES.map((t) => ({ value: t, label: t }))} />
      <Select label="Who it is for" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })} options={AUDIENCES.map((a) => ({ value: a, label: AUDIENCE_LABEL[a] }))} />
      {!existing && (
        <>
          <Field label="First date" type="date" value={form.first_date} onChange={set('first_date')} error={errors.first_date} />
          <Select
            label="Repeats"
            value={form.rule}
            onChange={(e) => setForm({ ...form, rule: e.target.value as SeriesForm['rule'] })}
            options={[
              { value: 'monthly_weekday', label: 'Monthly, on the same weekday' },
              { value: 'weekly', label: 'Every N weeks' },
            ]}
          />
          {form.rule === 'weekly' ? (
            <Field label="Every how many weeks" inputMode="numeric" value={form.interval_weeks} onChange={set('interval_weeks')} error={errors.interval_weeks} />
          ) : (
            <Select
              label="Which one in the month"
              value={form.nth}
              onChange={set('nth')}
              options={[
                { value: '1', label: '1st' }, { value: '2', label: '2nd' }, { value: '3', label: '3rd' },
                { value: '4', label: '4th' }, { value: '5', label: 'Last' },
              ]}
            />
          )}
        </>
      )}
      <Field label={`Start time (${existing?.timezone ?? TEAM_TIMEZONE})`} type="time" value={form.start_time} onChange={set('start_time')} error={errors.start_time} />
      <Field label="Duration (minutes)" inputMode="numeric" value={form.duration_minutes} onChange={set('duration_minutes')} error={errors.duration_minutes} />
      <Field label="Last date (optional)" type="date" value={form.until_date} onChange={set('until_date')} error={errors.until_date} />
      <Field label="Number of meetings (optional)" inputMode="numeric" value={form.max_count} onChange={set('max_count')} error={errors.max_count} />
      <Field label="Location (optional)" value={form.location_name} maxLength={120} onChange={set('location_name')} error={errors.location_name} />
      <Textarea label="Description (optional)" value={form.description} maxLength={5000} onChange={set('description')} error={errors.description} />
      {existing && (
        <Field
          label="Apply from this date (optional)"
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          hint="Leave empty to change every future meeting. Meetings someone edited by hand are left alone."
        />
      )}
      {preview.length > 0 && !existing && <p className="odz-muted">Next dates: {preview.join(', ')}</p>}
      {failed && <p role="alert" style={err}>{failed}</p>}
      <div className="odz-row">
        <Button variant="accent" disabled={busy} onClick={() => void submit()}>
          {existing ? 'Save series' : 'Create series'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    </div>
  )
}
