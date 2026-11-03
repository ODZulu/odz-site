import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, ConfirmAction, Field, Panel, Select, Textarea } from '../components'
import {
  agendaMessage,
  emptyItemForm,
  eventMinutes,
  KIND_LABEL,
  moveItem,
  overrunMinutes,
  publishState,
  showUpdatedMark,
  totalMinutes,
  validateItem,
  VISIBILITY_LABEL,
  type Agenda,
  type AgendaItem,
  type ItemErrors,
  type ItemForm,
  type ItemKind,
  type Visibility,
} from '../lib/agenda'
import { Markdown } from '../lib/markdown'
import { supabase } from '../lib/supabase'
import { formatTimeL } from '../lib/time'
import { LiveVotePanel } from './LiveVotePanel'
import { useLoad } from '../lib/useLoad'

type EventRow = { id: string; title: string; event_type: string; starts_at: string; ends_at: string | null; status: string }
type Member = { id: string; callsign: string }
type DocRow = { id: string; title: string; slug: string; version: string }
type Link_ = { item_id: string; document_id: string }
type Loaded = {
  event: EventRow
  agenda: Agenda | null
  items: AgendaItem[]
  notes: Record<string, string>
  links: Link_[]
  docs: DocRow[]
  members: Member[]
  log: { action: string; actor_callsign: string | null; created_at: string }[]
}

async function load(eventId: string): Promise<Loaded | null> {
  const ev = await supabase!.from('events').select('id,title,event_type,starts_at,ends_at,status').eq('id', eventId).maybeSingle()
  if (ev.error) throw new Error('agenda')
  if (!ev.data) return null
  const ag = await supabase!.from('agendas').select('id,event_id,status,publish_count,published_at').eq('event_id', eventId).maybeSingle()
  if (ag.error) throw new Error('agenda')
  const agenda = (ag.data as Agenda | null) ?? null
  const empty: Loaded = { event: ev.data as EventRow, agenda, items: [], notes: {}, links: [], docs: [], members: [], log: [] }
  if (!agenda) return empty
  const [items, notes, links, docs, members, log] = await Promise.all([
    supabase!.from('agenda_items').select('*').eq('agenda_id', agenda.id).order('position').order('created_at'),
    supabase!.from('agenda_item_notes').select('item_id,presenter_notes_md'),
    supabase!.from('agenda_item_documents').select('item_id,document_id'),
    supabase!.from('documents').select('id,title,slug,version').order('title'),
    supabase!.from('profiles').select('id,callsign').eq('status', 'approved').order('callsign'),
    supabase!.from('agenda_publish_log').select('action,actor_callsign,created_at').eq('agenda_id', agenda.id).order('created_at'),
  ])
  if (items.error || notes.error || links.error) throw new Error('agenda')
  const noteMap: Record<string, string> = {}
  for (const n of (notes.data ?? []) as { item_id: string; presenter_notes_md: string }[]) noteMap[n.item_id] = n.presenter_notes_md
  return {
    ...empty,
    items: (items.data ?? []) as AgendaItem[],
    notes: noteMap,
    links: (links.data ?? []) as Link_[],
    docs: (docs.data ?? []) as DocRow[],
    members: (members.data ?? []) as Member[],
    log: (log.data ?? []) as Loaded['log'],
  }
}

/**
 * The agenda for one Meeting (MVA-245). Command builds and publishes it; members read the
 * published, Members-level items; presenters also see their own items and notes. The database
 * decides who sees what; this page only shows what the rows it was given allow.
 */
export default function AgendaPage() {
  const { eventId = '' } = useParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const data = useLoad(() => load(eventId), [eventId])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [includeNonMembers, setIncludeNonMembers] = useState(false)
  const [includePresenterNotes, setIncludePresenterNotes] = useState(false)
  const write = can('write_events')

  if (data.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  const d = data.data
  if (data.failed || !d) {
    return (
      <>
        <h1 className="odz-title">Not found</h1>
        <p>
          <Link to="/calendar">Back to the calendar</Link>
        </p>
      </>
    )
  }
  const { event, agenda, items } = d
  const state = publishState(agenda, items)
  const total = totalMinutes(items)
  const over = overrunMinutes(total, eventMinutes(event.starts_at, event.ends_at))
  const presenterName = (id: string | null) => (id ? (d.members.find((m) => m.id === id)?.callsign ?? 'Former member') : null)

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) {
    setError(null)
    setBusy(true)
    const { error: err } = await fn()
    setBusy(false)
    if (err) return setError(agendaMessage(err.message))
    after?.()
    await data.reload()
  }

  async function saveItem(id: string | 'new', f: ItemForm) {
    const row = {
      title: f.title.trim(),
      planned_minutes: Number(f.planned_minutes),
      kind: f.kind,
      presenter_id: f.presenter_id || null,
      visibility: f.visibility,
      notes_md: f.notes_md.trim() || null,
      vote_wording: f.kind === 'vote' ? f.vote_wording.trim() || null : null,
      outcome_md: f.outcome_md.trim() || null,
    }
    setError(null)
    setBusy(true)
    let itemId = id as string
    if (id === 'new') {
      const { data: created, error: err } = await supabase!
        .from('agenda_items')
        .insert({ ...row, agenda_id: agenda!.id, position: items.length + 1 })
        .select('id')
        .single()
      if (err || !created) {
        setBusy(false)
        return setError(agendaMessage(err?.message))
      }
      itemId = (created as { id: string }).id
    } else {
      const { error: err } = await supabase!.from('agenda_items').update(row).eq('id', id)
      if (err) {
        setBusy(false)
        return setError(agendaMessage(err.message))
      }
    }
    const notesText = f.presenter_notes_md.trim()
    const hadNotes = itemId in d!.notes
    if (notesText) {
      const { error: err } = hadNotes
        ? await supabase!.from('agenda_item_notes').update({ presenter_notes_md: notesText }).eq('item_id', itemId)
        : await supabase!.from('agenda_item_notes').insert({ item_id: itemId, presenter_notes_md: notesText })
      if (err) {
        setBusy(false)
        return setError(agendaMessage(err.message))
      }
    } else if (hadNotes) {
      await supabase!.from('agenda_item_notes').delete().eq('item_id', itemId)
    }
    setBusy(false)
    setEditing(null)
    await data.reload()
  }

  async function createMinutes() {
    setError(null)
    setBusy(true)
    const { data: id, error: err } = await supabase!.rpc('create_minutes_from_agenda', {
      p_agenda: agenda!.id,
      p_include_presenter_notes: includePresenterNotes,
      p_include_command_items: includeNonMembers,
    })
    setBusy(false)
    if (err || !id) return setError(agendaMessage(err?.message))
    navigate(`/minutes/${id as string}/edit`)
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/calendar">Calendar</Link>
      </p>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '0.25rem' }}>
        <h1 className="odz-title">Agenda: {event.title}</h1>
        {agenda && (
          <Chip variant={state === 'published' ? 'go' : 'pending'}>
            {state === 'draft' ? 'DRAFT' : state === 'published' ? 'PUBLISHED' : 'EDITED, NOT REPUBLISHED'}
          </Chip>
        )}
      </div>
      <p className="odz-muted" style={{ marginBottom: '1rem' }}>
        {formatTimeL(event.starts_at)}
        {event.ends_at ? `-${formatTimeL(event.ends_at)}` : ''}
      </p>

      {!agenda ? (
        write && event.event_type === 'Meeting' ? (
          <Panel title="No agenda yet">
            <Button
              disabled={busy}
              onClick={() => void run(() => supabase!.from('agendas').insert({ event_id: event.id }))}
            >
              Start an agenda
            </Button>
          </Panel>
        ) : (
          <p className="odz-muted">There is no agenda for this meeting yet.</p>
        )
      ) : (
        <>
          {agenda.status === 'draft' && (
            <p className="odz-muted" style={{ marginBottom: '0.75rem' }}>
              Draft: only Command can see this until it is published.
            </p>
          )}
          <p style={{ marginBottom: '0.75rem' }}>
            Planned: {total} min
            {eventMinutes(event.starts_at, event.ends_at) !== null && ` of ${eventMinutes(event.starts_at, event.ends_at)} min scheduled`}
          </p>
          {over > 0 && (
            <p role="alert" style={{ color: 'var(--alert)', marginBottom: '0.75rem' }}>
              This agenda runs {over} min over the meeting.
            </p>
          )}

          <Panel title="Items">
            {items.length === 0 ? (
              <p className="odz-muted">No items yet.</p>
            ) : (
              <ol style={{ listStyle: 'none', padding: 0, margin: 0 }} className="odz-stack">
                {items.map((it, idx) => (
                  <li key={it.id} className="odz-event">
                    {editing === it.id ? (
                      <ItemEditor
                        initial={formFor(it, d.notes[it.id])}
                        members={d.members}
                        busy={busy}
                        onSave={(f) => saveItem(it.id, f)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <>
                        <div className="odz-row">
                          <strong>
                            {idx + 1}. {it.title}
                          </strong>
                          <Chip variant="plain">{KIND_LABEL[it.kind].toUpperCase()}</Chip>
                          {it.visibility !== 'members' && <Chip variant="accent">{VISIBILITY_LABEL[it.visibility].toUpperCase()}</Chip>}
                          {agenda && showUpdatedMark(it, agenda) && <Chip variant="pending">UPDATED</Chip>}
                          {write && it.edited_since_publish && <Chip variant="pending">EDITED</Chip>}
                        </div>
                        <p className="odz-muted">
                          {it.planned_minutes} min{it.presenter_id ? `, presented by ${presenterName(it.presenter_id)}` : ''}
                        </p>
                        {it.notes_md && <Markdown source={it.notes_md} />}
                        {it.kind === 'vote' && it.vote_wording && (
                          <p style={{ whiteSpace: 'pre-wrap', margin: '0.5rem 0' }}>
                            <strong>Motion:</strong> {it.vote_wording}
                          </p>
                        )}
                        {d.notes[it.id] && (
                          <div style={{ margin: '0.5rem 0' }}>
                            <span className="odz-label">Presenter notes</span>
                            <Markdown source={d.notes[it.id]} />
                          </div>
                        )}
                        {d.links
                          .filter((l) => l.item_id === it.id)
                          .map((l) => d.docs.find((x) => x.id === l.document_id))
                          .filter((x): x is DocRow => !!x)
                          .map((doc) => (
                            <p key={doc.id}>
                              Pre-read: <Link to={`/documents/${doc.slug}`}>{doc.title}</Link>
                            </p>
                          ))}
                        {it.kind === 'vote' && agenda.status === 'published' && (
                          <LiveVotePanel
                            itemId={it.id}
                            canChair={write}
                            members={d.members}
                            hasWording={!!it.vote_wording && it.vote_wording.trim() !== ''}
                          />
                        )}
                        {it.outcome_md && (
                          <p style={{ whiteSpace: 'pre-wrap' }}>
                            <strong>Outcome:</strong> {it.outcome_md}
                          </p>
                        )}
                        {write && (
                          <div className="odz-row" style={{ marginTop: '0.5rem' }}>
                            <Button small variant="sec" onClick={() => setEditing(it.id)}>
                              Edit
                            </Button>
                            <Button
                              small
                              variant="ghost"
                              disabled={busy || idx === 0}
                              aria-label={`Move ${it.title} up`}
                              onClick={() => void reorder(moveItem(items.map((x) => x.id), idx, -1))}
                            >
                              Up
                            </Button>
                            <Button
                              small
                              variant="ghost"
                              disabled={busy || idx === items.length - 1}
                              aria-label={`Move ${it.title} down`}
                              onClick={() => void reorder(moveItem(items.map((x) => x.id), idx, 1))}
                            >
                              Down
                            </Button>
                            <ConfirmAction
                              label="Delete item"
                              onConfirm={() => run(() => supabase!.from('agenda_items').delete().eq('id', it.id))}
                            />
                          </div>
                        )}
                        {write && (
                          <LinkDocs
                            item={it}
                            docs={d.docs}
                            linked={d.links.filter((l) => l.item_id === it.id).map((l) => l.document_id)}
                            busy={busy}
                            run={run}
                          />
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {write && editing === 'new' && (
              <div style={{ marginTop: '1rem' }}>
                <ItemEditor
                  initial={emptyItemForm}
                  members={d.members}
                  busy={busy}
                  onSave={(f) => saveItem('new', f)}
                  onCancel={() => setEditing(null)}
                />
              </div>
            )}
            {write && editing !== 'new' && (
              <div style={{ marginTop: '1rem' }}>
                <Button variant="sec" onClick={() => setEditing('new')}>
                  Add an item
                </Button>
              </div>
            )}
          </Panel>

          {write && (
            <Panel title="Publish">
              <p className="odz-muted" style={{ marginBottom: '0.5rem' }}>
                {agenda.status === 'draft'
                  ? 'Publishing shows the Members-level items to every member who can read event details and notifies them.'
                  : state === 'pending_update'
                    ? 'Items changed since the last publish. Publishing again notifies members and marks the changed items updated.'
                    : 'Published. Edit an item to be able to publish an update.'}
              </p>
              <Button
                variant="accent"
                disabled={busy || state === 'published'}
                onClick={() => void run(() => supabase!.rpc('publish_agenda', { p_agenda: agenda.id }))}
              >
                {agenda.status === 'draft' ? 'Publish agenda' : 'Publish update'}
              </Button>
              {d.log.length > 0 && (
                <ul className="odz-muted" style={{ marginTop: '0.75rem' }}>
                  {d.log.map((l, i) => (
                    <li key={i}>
                      {l.action === 'published' ? 'Published' : 'Republished'} by {l.actor_callsign ?? 'Former member'},{' '}
                      {new Date(l.created_at).toLocaleString()}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {write && can('write_minutes') && (
            <Panel title="After the meeting">
              <div className="odz-stack">
                <label className="odz-row" style={{ gap: '0.5rem' }}>
                  <input type="checkbox" checked={includeNonMembers} onChange={(e) => setIncludeNonMembers(e.target.checked)} />
                  Include Command-only and presenter-only items
                </label>
                <label className="odz-row" style={{ gap: '0.5rem' }}>
                  <input type="checkbox" checked={includePresenterNotes} onChange={(e) => setIncludePresenterNotes(e.target.checked)} />
                  Include presenter notes
                </label>
                <Button variant="sec" disabled={busy} onClick={() => void createMinutes()}>
                  Create minutes from agenda
                </Button>
              </div>
            </Panel>
          )}
        </>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--alert)', margin: '0.75rem 0' }}>
          {error}
        </p>
      )}
    </>
  )

  async function reorder(order: string[] | null) {
    if (!order) return
    await run(() => supabase!.rpc('reorder_agenda_items', { p_agenda: agenda!.id, p_order: order }))
  }
}

function formFor(it: AgendaItem, presenterNotes: string | undefined): ItemForm {
  return {
    title: it.title,
    planned_minutes: String(it.planned_minutes),
    kind: it.kind,
    presenter_id: it.presenter_id ?? '',
    visibility: it.visibility,
    notes_md: it.notes_md ?? '',
    presenter_notes_md: presenterNotes ?? '',
    vote_wording: it.vote_wording ?? '',
    outcome_md: it.outcome_md ?? '',
  }
}

function ItemEditor({
  initial,
  members,
  busy,
  onSave,
  onCancel,
}: {
  initial: ItemForm
  members: Member[]
  busy: boolean
  onSave: (f: ItemForm) => void | Promise<void>
  onCancel: () => void
}) {
  const [f, setF] = useState<ItemForm>(initial)
  const [errors, setErrors] = useState<ItemErrors>({})
  const set = <K extends keyof ItemForm>(k: K, v: ItemForm[K]) => setF((cur) => ({ ...cur, [k]: v }))
  return (
    <div className="odz-stack">
      <Field label="Item title" value={f.title} maxLength={160} error={errors.title} onChange={(e) => set('title', e.target.value)} />
      <Field
        label="Planned minutes"
        inputMode="numeric"
        value={f.planned_minutes}
        error={errors.planned_minutes}
        onChange={(e) => set('planned_minutes', e.target.value)}
      />
      <Select
        label="Kind"
        value={f.kind}
        onChange={(e) => set('kind', e.target.value as ItemKind)}
        options={(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
      />
      <Select
        label="Who can see this item"
        value={f.visibility}
        onChange={(e) => set('visibility', e.target.value as Visibility)}
        options={(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((k) => ({ value: k, label: VISIBILITY_LABEL[k] }))}
      />
      <Select
        label="Presenter"
        value={f.presenter_id}
        onChange={(e) => set('presenter_id', e.target.value)}
        options={[{ value: '', label: 'None' }, ...members.map((m) => ({ value: m.id, label: m.callsign }))]}
      />
      {errors.presenter_id && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {errors.presenter_id}
        </p>
      )}
      <Textarea label="Notes (markdown)" value={f.notes_md} error={errors.notes_md} onChange={(e) => set('notes_md', e.target.value)} />
      {f.kind === 'vote' && (
        <Textarea
          label="Exact motion wording"
          value={f.vote_wording}
          error={errors.vote_wording}
          onChange={(e) => set('vote_wording', e.target.value)}
          hint="Shown to everyone who can see this item, word for word."
        />
      )}
      <Textarea
        label="Presenter notes"
        value={f.presenter_notes_md}
        error={errors.presenter_notes_md}
        onChange={(e) => set('presenter_notes_md', e.target.value)}
        hint="Only the presenter, Command and Admin can read these."
      />
      <Textarea
        label="Outcome (after the meeting)"
        value={f.outcome_md}
        error={errors.outcome_md}
        onChange={(e) => set('outcome_md', e.target.value)}
      />
      <div className="odz-row">
        <Button
          variant="accent"
          disabled={busy}
          onClick={() => {
            const found = validateItem(f)
            setErrors(found)
            if (Object.keys(found).length === 0) void onSave(f)
          }}
        >
          Save item
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function LinkDocs({
  item,
  docs,
  linked,
  busy,
  run,
}: {
  item: AgendaItem
  docs: DocRow[]
  linked: string[]
  busy: boolean
  run: (fn: () => PromiseLike<{ error: { message: string } | null }>) => Promise<void>
}) {
  const [pick, setPick] = useState('')
  const available = docs.filter((x) => !linked.includes(x.id))
  return (
    <div className="odz-row" style={{ marginTop: '0.5rem' }}>
      {linked.map((id) => {
        const doc = docs.find((x) => x.id === id)
        return (
          <Button
            key={id}
            small
            variant="ghost"
            disabled={busy}
            aria-label={`Unlink ${doc?.title ?? 'document'} from ${item.title}`}
            onClick={() => void run(() => supabase!.from('agenda_item_documents').delete().eq('item_id', item.id).eq('document_id', id))}
          >
            Unlink {doc?.title ?? 'document'}
          </Button>
        )
      })}
      {available.length > 0 && (
        <>
          <Select
            label={`Pre-read for ${item.title}`}
            hideLabel
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            options={[{ value: '', label: 'Link a document' }, ...available.map((x) => ({ value: x.id, label: `${x.title} v${x.version}` }))]}
          />
          <Button
            small
            variant="sec"
            disabled={busy || !pick}
            onClick={() => {
              const id = pick
              setPick('')
              void run(() => supabase!.from('agenda_item_documents').insert({ item_id: item.id, document_id: id }))
            }}
          >
            Link
          </Button>
        </>
      )}
    </div>
  )
}
