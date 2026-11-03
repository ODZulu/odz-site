import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { liveMessage, parseQuorum } from '../lib/liveVote'
import { Button, Chip, Field, Panel, Select, Table, Textarea } from '../components'
import {
  bodyLabel,
  DEFAULT_DEADLINE_HOURS,
  filterMotions,
  motionMessage,
  parseOptions,
  statusLabel,
  timeLeft,
  type Motion,
  type MotionBody,
  type MotionFilter,
} from '../lib/motions'
import { supabase } from '../lib/supabase'
import { useLoad } from '../lib/useLoad'

const COLUMNS = 'id,type,title,description,options,body,round,deadline,state,status,opened_by,opened_by_callsign,outcome_option,created_at'

/**
 * Motions (MVA-233): open and closed motions, with filters. Visible to Old Guard, Command and
 * Admin, and to anyone a motion names as a party (the database decides; others simply see none).
 */
export default function Motions() {
  const { can, session, isAdmin } = useAuth()
  const [filter, setFilter] = useState<MotionFilter>('open')
  const [creating, setCreating] = useState(false)
  const list = useLoad(async () => {
    // Settle any lapsed rounds first; idempotent, and what keeps dev working without pg_cron.
    await supabase!.rpc('process_motions')
    const { data, error } = await supabase!.from('motions').select(COLUMNS).order('created_at', { ascending: false })
    if (error) throw new Error('motions')
    return data as unknown as Motion[]
  })
  const rows = filterMotions(list.data ?? [], filter, session?.user.id)

  return (
    <>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">Motions</h1>
        {can('open_motions') && !creating && (
          <Button onClick={() => setCreating(true)}>Open a motion</Button>
        )}
      </div>
      {creating && (
        <NewMotion
          onDone={() => {
            setCreating(false)
            void list.reload()
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {isAdmin && <QuorumPanel />}
      <Panel title="Motions">
        <div style={{ marginBottom: '0.75rem' }}>
          <Select
            label="Show"
            value={filter}
            onChange={(e) => setFilter(e.target.value as MotionFilter)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
              { value: 'mine', label: 'Opened by me' },
              { value: 'all', label: 'All' },
            ]}
          />
        </div>
        {list.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : list.failed ? (
          <p role="alert">Could not load the motions.</p>
        ) : rows.length === 0 ? (
          <p className="odz-muted">No motions here.</p>
        ) : (
          <Table
            rows={rows}
            rowKey={(m) => m.id}
            columns={[
              { header: 'Motion', kind: 'cs', render: (m) => <Link to={`/motions/${m.id}`}>{m.title}</Link> },
              { header: 'Body', render: (m) => bodyLabel(m.body) },
              {
                header: 'Status',
                kind: 'status',
                render: (m) => (
                  <Chip variant={m.state === 'closed' ? 'plain' : 'pending'}>
                    {statusLabel(m)}
                  </Chip>
                ),
              },
              { header: 'Result / time', render: (m) => (m.state === 'closed' ? (m.outcome_option ?? '-') : (timeLeft(m.deadline) ?? '-')) },
            ]}
          />
        )}
      </Panel>
    </>
  )
}

type Member = { id: string; callsign: string }

function NewMotion({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [optionsText, setOptionsText] = useState('Approve\nReject')
  const [body, setBody] = useState<MotionBody>('command')
  const [hours, setHours] = useState(String(DEFAULT_DEADLINE_HOURS))
  const [parties, setParties] = useState<string[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase!.from('profiles').select('id,callsign').eq('status', 'approved').order('callsign')
      setMembers((data ?? []) as Member[])
    })()
  }, [])

  async function submit() {
    setError(null)
    const options = parseOptions(optionsText)
    if (!options) return setError(motionMessage('bad_options'))
    if (title.trim().length < 3) return setError('Give the motion a title (3 to 120 characters).')
    const h = Number(hours)
    if (!Number.isInteger(h) || h < 1 || h > 720) return setError('The deadline is 1 to 720 hours.')
    setBusy(true)
    const { error: err } = await supabase!.rpc('open_motion', {
      p_type: 'general',
      p_title: title.trim(),
      p_description: description.trim(),
      p_options: options,
      p_body: body,
      p_deadline_hours: h,
      p_parties: parties,
    })
    setBusy(false)
    if (err) return setError(motionMessage(err.message))
    onDone()
  }

  return (
    <Panel title="Open a motion">
      <div className="odz-stack">
        <Field label="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          label="Description"
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
          hint="What is being decided, in the exact words the voters will see."
        />
        <Textarea
          label="Options (one per line)"
          value={optionsText}
          onChange={(e) => setOptionsText(e.target.value)}
          hint="2 to 6 choices. Approve and Reject by default."
        />
        <Select
          label="Who votes"
          value={body}
          onChange={(e) => setBody(e.target.value as MotionBody)}
          options={[
            { value: 'command', label: 'Command (escalates to the Old Guard on a tie)' },
            { value: 'old_guard', label: 'Old Guard (Command included)' },
          ]}
        />
        <Field label="Deadline (hours)" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="odz-label">Parties (cannot vote)</legend>
          <div style={{ maxHeight: '10rem', overflowY: 'auto' }}>
            {members.map((m) => (
              <label key={m.id} className="odz-row" style={{ gap: '0.5rem', minHeight: '2.5rem' }}>
                <input
                  type="checkbox"
                  checked={parties.includes(m.id)}
                  onChange={(e) => setParties(e.target.checked ? [...parties, m.id] : parties.filter((x) => x !== m.id))}
                />
                {m.callsign}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" style={{ color: 'var(--alert)' }}>{error}</p>}
        <div className="odz-row">
          <Button variant="accent" disabled={busy} onClick={() => void submit()}>
            Open motion
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  )
}

/**
 * Quorum for live meeting votes (MVA-246). A setting with no default: empty means no quorum rule.
 * When set, a vote with fewer votes cast (abstentions count) than the quorum has no result.
 */
function QuorumPanel() {
  const current = useLoad(async () => {
    const { data, error } = await supabase!.from('meeting_vote_settings').select('quorum').eq('singleton', true).maybeSingle()
    if (error) throw new Error('quorum')
    return ((data as { quorum: number | null } | null)?.quorum ?? null) as number | null
  })
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const parsed = parseQuorum(text)
    if (!parsed.ok) return setError(liveMessage('bad_quorum'))
    setError(null)
    setBusy(true)
    const { error: err } = await supabase!.rpc('set_vote_quorum', { p_quorum: parsed.value })
    setBusy(false)
    if (err) return setError(liveMessage(err.message))
    setText('')
    await current.reload()
  }

  return (
    <Panel title="Meeting vote quorum (Admin)">
      <div className="odz-stack">
        <p>
          {current.loading
            ? 'Loading'
            : current.data === null || current.data === undefined
              ? 'No quorum is set. Live votes decide by a strict majority of eligible voters.'
              : `Quorum: ${current.data} votes cast (abstentions count).`}
        </p>
        <Field label="Quorum (votes cast; leave empty for none)" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} />
        {error && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {error}
          </p>
        )}
        <Button disabled={busy} onClick={() => void save()}>
          Save quorum
        </Button>
      </div>
    </Panel>
  )
}
