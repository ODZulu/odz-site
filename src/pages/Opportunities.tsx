import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, ConfirmAction, Chip, Field, Panel, Select, Textarea } from '../components'
import { EVENT_TYPES, type EventType } from '../lib/events'
import {
  costLabel,
  countsLine,
  emptyOpportunityForm,
  filterOpportunities,
  hasOpportunityErrors,
  opportunityMessage,
  RESPONSES,
  STATUS_LABEL,
  toForm,
  toSaveArgs,
  validateOpportunity,
  type Opportunity,
  type OpportunityErrors,
  type OpportunityForm,
  type Responder,
  type Response,
  type StatusFilter,
} from '../lib/opportunities'
import { supabase } from '../lib/supabase'
import { formatPlainDate } from '../lib/time'
import { useLoad } from '../lib/useLoad'

/**
 * Event opportunities (MVA-230): outside events the team might attend. Members say In, Maybe or
 * Out; that is advice for Command, never a commitment. Command promotes the chosen ones into real
 * events, or drops them with a reason. The database decides who may do what.
 */
export default function Opportunities() {
  const { can, session } = useAuth()
  const [status, setStatus] = useState<StatusFilter>('open')
  const [onlyIn, setOnlyIn] = useState(false)
  const [editing, setEditing] = useState<'new' | Opportunity | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const list = useLoad(async () => {
    const { data, error } = await supabase!.rpc('opportunity_list')
    if (error) throw new Error('opportunities')
    return data as Opportunity[]
  })
  const rows = filterOpportunities(list.data ?? [], status, onlyIn)
  const me = session?.user.id

  return (
    <>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">Opportunities</h1>
        {can('write_opportunities') && editing === null && <Button onClick={() => setEditing('new')}>Add an opportunity</Button>}
      </div>
      <p className="odz-muted" style={{ marginBottom: '1rem' }}>
        Outside events the team might attend. Your answer helps Command decide; it does not commit you or the team.
      </p>
      {editing !== null && (
        <OpportunityFormPanel
          existing={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null)
            void list.reload()
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {notice && (
        <p role="status" style={{ marginBottom: '1rem' }}>
          {notice}
        </p>
      )}
      <Panel title="Opportunities">
        <div className="odz-row" style={{ gap: '1rem', marginBottom: '0.75rem', alignItems: 'flex-end' }}>
          <Select
            label="Show"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'promoted', label: 'Promoted' },
              { value: 'dropped', label: 'Dropped' },
              { value: 'expired', label: 'Expired' },
              { value: 'all', label: 'All' },
            ]}
          />
          <label className="odz-row" style={{ gap: '0.5rem', minHeight: '2.5rem' }}>
            <input type="checkbox" checked={onlyIn} onChange={(e) => setOnlyIn(e.target.checked)} />
            {"I'm In"}
          </label>
        </div>
        {list.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : list.failed ? (
          <p role="alert">Could not load the opportunities.</p>
        ) : rows.length === 0 ? (
          <p className="odz-muted">No opportunities here.</p>
        ) : (
          <ul className="odz-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.map((o) => (
              <OpportunityCard
                key={o.id}
                o={o}
                canEdit={o.status === 'open' && (can('manage_opportunities') || (can('write_opportunities') && o.created_by === me))}
                onEdit={() => {
                  setNotice(null)
                  setEditing(o)
                }}
                onChanged={(message) => {
                  setNotice(message ?? null)
                  void list.reload()
                }}
              />
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}

function OpportunityCard({
  o,
  canEdit,
  onEdit,
  onChanged,
}: {
  o: Opportunity
  canEdit: boolean
  onEdit: () => void
  onChanged: (message?: string) => void
}) {
  const { can } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showWho, setShowWho] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const isOpen = o.status === 'open'
  const dates = o.ends_on && o.ends_on !== o.starts_on ? `${formatPlainDate(o.starts_on)} to ${formatPlainDate(o.ends_on)}` : formatPlainDate(o.starts_on)

  async function respond(r: Response) {
    setError(null)
    setBusy(true)
    const { error: err } = await supabase!.rpc('opportunity_respond', { p_opportunity: o.id, p_response: r })
    setBusy(false)
    if (err) return setError(opportunityMessage(err.message))
    onChanged()
  }

  return (
    <li className="odz-panel" style={{ padding: '0.75rem 1rem' }}>
      <div className="odz-row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
        <h2 className="odz-day" style={{ margin: 0 }}>
          {o.title}
        </h2>
        <Chip variant={isOpen ? 'pending' : 'plain'}>{STATUS_LABEL[o.status]}</Chip>
      </div>
      <p>{dates}</p>
      {(o.host || o.location_text) && <p className="odz-muted">{[o.host, o.location_text].filter(Boolean).join(' · ')}</p>}
      <p className="odz-muted">Cost: {costLabel(o.est_cost_cents)}</p>
      {o.source_url && (
        <p>
          <a href={o.source_url} target="_blank" rel="noopener noreferrer">
            Event page
          </a>
        </p>
      )}
      {o.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{o.notes}</p>}
      {o.status === 'dropped' && o.drop_reason && <p className="odz-muted">Dropped: {o.drop_reason}</p>}
      {o.status === 'promoted' && <p className="odz-muted">Now a team event. Find it on the calendar.</p>}
      <p className="odz-muted">
        {countsLine(o)}
        {o.my_response ? ` · You: ${o.my_response}` : ''}
      </p>
      {isOpen && (
        <div className="odz-row" role="group" aria-label={`Your answer for ${o.title}`} style={{ gap: '0.5rem', margin: '0.5rem 0' }}>
          {RESPONSES.map((r) => (
            <Button key={r} small variant={o.my_response === r ? 'primary' : 'sec'} disabled={busy} aria-pressed={o.my_response === r} onClick={() => void respond(r)}>
              {r}
            </Button>
          ))}
        </div>
      )}
      <div className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button small variant="ghost" onClick={() => setShowWho(!showWho)} aria-expanded={showWho}>
          {showWho ? 'Hide who answered' : 'Who answered'}
        </Button>
        {canEdit && (
          <Button small variant="sec" onClick={onEdit}>
            Edit
          </Button>
        )}
        {isOpen && can('manage_opportunities') && can('write_events') && !promoting && (
          <Button small variant="primary" onClick={() => setPromoting(true)}>
            Promote to event
          </Button>
        )}
        {isOpen && can('manage_opportunities') && !dropping && (
          <Button small variant="sec" onClick={() => setDropping(true)}>
            Drop
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
      {showWho && <Who id={o.id} />}
      {promoting && (
        <PromoteBox
          id={o.id}
          onCancel={() => setPromoting(false)}
          onDone={() => {
            setPromoting(false)
            onChanged('Promoted. The event is on the calendar and the members who answered In or Maybe were told. Set its start time by editing the event.')
          }}
        />
      )}
      {dropping && (
        <DropBox
          id={o.id}
          onCancel={() => setDropping(false)}
          onDone={() => {
            setDropping(false)
            onChanged('Dropped. Everyone who answered was told.')
          }}
        />
      )}
    </li>
  )
}

/** Names behind the counts. The database refuses anyone below Old Guard, so they just see this message. */
function Who({ id }: { id: string }) {
  const who = useLoad(async () => {
    const { data, error } = await supabase!.rpc('opportunity_responders', { p_opportunity: id })
    if (error) throw new Error('who')
    return data as Responder[]
  })
  if (who.loading) return <p className="odz-muted" role="status">Loading</p>
  if (who.failed) return <p className="odz-muted">Names are shown to Old Guard and Command only.</p>
  const rows = who.data ?? []
  if (rows.length === 0) return <p className="odz-muted">Nobody has answered yet.</p>
  return (
    <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
      {rows.map((r) => (
        <li key={r.profile_id}>
          {r.callsign ?? 'Unknown'}: {r.response}
        </li>
      ))}
    </ul>
  )
}

function PromoteBox({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const [type, setType] = useState<EventType>('Other')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function promote() {
    setError(null)
    setBusy(true)
    const { error: err } = await supabase!.rpc('opportunity_promote', { p_opportunity: id, p_event_type: type })
    setBusy(false)
    if (err) return setError(opportunityMessage(err.message))
    onDone()
  }

  return (
    <div className="odz-stack" style={{ marginTop: '0.75rem' }}>
      <Select label="Event type" value={type} onChange={(e) => setType(e.target.value as EventType)} options={EVENT_TYPES.map((t) => ({ value: t, label: t }))} />
      <p className="odz-muted">Creates a team event, tells members who answered In or Maybe that registration is open, and registers nobody.</p>
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
      <div className="odz-row">
        <ConfirmAction label="Promote" small={false} variant="primary" disabled={busy} onConfirm={promote} />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function DropBox({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function drop() {
    setError(null)
    setBusy(true)
    const { error: err } = await supabase!.rpc('opportunity_drop', { p_opportunity: id, p_reason: reason })
    setBusy(false)
    if (err) return setError(opportunityMessage(err.message))
    onDone()
  }

  return (
    <div className="odz-stack" style={{ marginTop: '0.75rem' }}>
      <Textarea label="Reason for dropping" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint="Everyone who answered is told this." />
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
      <div className="odz-row">
        <ConfirmAction label="Drop" small={false} variant="primary" disabled={busy || reason.trim().length < 3} onConfirm={drop} />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function OpportunityFormPanel({ existing, onDone, onCancel }: { existing: Opportunity | null; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<OpportunityForm>(existing ? toForm(existing) : emptyOpportunityForm)
  const [errors, setErrors] = useState<OpportunityErrors>({})
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof OpportunityForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  async function submit() {
    const found = validateOpportunity(form)
    setErrors(found)
    setFailed(null)
    if (hasOpportunityErrors(found)) return
    setBusy(true)
    const { error } = await supabase!.rpc('opportunity_save', toSaveArgs(existing?.id ?? null, form))
    setBusy(false)
    if (error) return setFailed(opportunityMessage(error.message))
    onDone()
  }

  return (
    <Panel title={existing ? 'Edit opportunity' : 'Add an opportunity'}>
      <div className="odz-stack">
        <Field label="Title" value={form.title} maxLength={120} onChange={set('title')} error={errors.title} />
        <Field label="Host or company" value={form.host} maxLength={120} onChange={set('host')} error={errors.host} />
        <Field label="Event page (optional)" type="url" inputMode="url" value={form.source_url} onChange={set('source_url')} error={errors.source_url} />
        <Field label="Start date" type="date" value={form.starts_on} onChange={set('starts_on')} error={errors.starts_on} />
        <Field label="End date (optional)" type="date" value={form.ends_on} onChange={set('ends_on')} error={errors.ends_on} hint="Dates can be approximate." />
        <Field label="Location" value={form.location_text} maxLength={200} onChange={set('location_text')} error={errors.location_text} />
        <Field label="Estimated cost per person, dollars (optional)" inputMode="decimal" value={form.cost} onChange={set('cost')} error={errors.cost} />
        <Textarea label="Notes" value={form.notes} maxLength={2000} onChange={set('notes')} error={errors.notes} />
        {failed && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {failed}
          </p>
        )}
        <div className="odz-row">
          <Button variant="accent" disabled={busy} onClick={() => void submit()}>
            {existing ? 'Save changes' : 'Add opportunity'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  )
}
