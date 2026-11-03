import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, ConfirmAction, KeyValue, Panel, Select, Table, Textarea } from '../components'
import {
  bodyLabel,
  motionMessage,
  statusLabel,
  tally,
  timeLeft,
  type Motion,
  type MotionVote,
} from '../lib/motions'
import { supabase } from '../lib/supabase'
import { useLoad } from '../lib/useLoad'

type LogRow = {
  id: string
  round: number
  action: string
  actor_callsign: string | null
  option_from: string | null
  option_to: string | null
  detail: string | null
  created_at: string
}
type Recusal = { profile_id: string; callsign: string | null; round: number; reason: string }

type Loaded = {
  motion: Motion
  voters: string[]
  votes: MotionVote[]
  recusals: Recusal[]
  parties: string[]
  names: Record<string, string>
  log: LogRow[]
}

async function loadMotion(id: string): Promise<Loaded | null> {
  await supabase!.rpc('process_motions')
  const m = await supabase!.from('motions').select('*').eq('id', id).maybeSingle()
  if (m.error) throw new Error('motion')
  if (!m.data) return null
  const motion = m.data as unknown as Motion
  const [voters, votes, recusals, parties, log] = await Promise.all([
    supabase!.from('motion_voters').select('profile_id').eq('motion_id', id).eq('round', motion.round),
    supabase!.from('motion_votes').select('round,voter_id,voter_callsign,option,updated_at').eq('motion_id', id).order('updated_at'),
    supabase!.from('motion_recusals').select('profile_id,callsign,round,reason').eq('motion_id', id),
    supabase!.from('motion_parties').select('profile_id').eq('motion_id', id),
    supabase!.from('motion_log').select('id,round,action,actor_callsign,option_from,option_to,detail,created_at').eq('motion_id', id).order('created_at'),
  ])
  if (voters.error || votes.error || recusals.error || parties.error || log.error) throw new Error('motion')
  const voterIds = (voters.data ?? []).map((r: { profile_id: string }) => r.profile_id)
  const partyIds = (parties.data ?? []).map((r: { profile_id: string }) => r.profile_id)
  const ids = [...new Set([...voterIds, ...partyIds])]
  const names: Record<string, string> = {}
  if (ids.length > 0) {
    const p = await supabase!.from('profiles').select('id,callsign').in('id', ids)
    for (const r of (p.data ?? []) as { id: string; callsign: string }[]) names[r.id] = r.callsign
  }
  return {
    motion,
    voters: voterIds,
    votes: (votes.data ?? []) as unknown as MotionVote[],
    recusals: (recusals.data ?? []) as unknown as Recusal[],
    parties: partyIds,
    names,
    log: (log.data ?? []) as unknown as LogRow[],
  }
}

const ACTION_WORDS: Record<string, string> = {
  created: 'Created',
  opened: 'Opened',
  vote: 'Voted',
  vote_changed: 'Changed vote',
  recused: 'Recused',
  escalated: 'Escalated',
  decided: 'Decided',
  final_decided: 'Admin decision',
  withdrawn: 'Withdrawn',
}

export default function MotionDetail() {
  const { id = '' } = useParams()
  const { session, isAdmin, tierName } = useAuth()
  const data = useLoad(() => loadMotion(id), [id])
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [finalOption, setFinalOption] = useState('')
  const [busy, setBusy] = useState(false)

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
          <Link to="/motions">Back to the motions</Link>
        </p>
      </>
    )
  }
  const { motion: m } = d
  const self = session?.user.id
  const isVoter = !!self && d.voters.includes(self)
  const open = m.state === 'open' && (m.status === 'open' || m.status === 'escalated')
  const mine = d.votes.find((v) => v.round === m.round && v.voter_id === self)
  const roundVotes = d.votes.filter((v) => v.round === m.round)
  const counts = tally(m.options, roundVotes)
  const canWithdraw = (m.state === 'draft' || open || m.status === 'escalated_final') && d.votes.length === 0 &&
    (m.opened_by === self || isAdmin || tierName === 'Command')
  const name = (pid: string) => d.names[pid] ?? 'Former member'
  const voterName = (v: MotionVote) => v.voter_callsign ?? name(v.voter_id)

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setError(null)
    setBusy(true)
    const { error: err } = await fn()
    setBusy(false)
    if (err) setError(motionMessage(err.message))
    else {
      setReason('')
      await data.reload()
    }
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/motions">Motions</Link>
      </p>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <h1 className="odz-title">{m.title}</h1>
        <Chip variant={m.state === 'closed' ? 'plain' : 'pending'}>{statusLabel(m)}</Chip>
      </div>

      <Panel title="Motion">
        {m.description && <p style={{ whiteSpace: 'pre-wrap', marginBottom: '0.75rem' }}>{m.description}</p>}
        <KeyValue
          items={[
            ['Opened by', m.opened_by_callsign ?? 'Former member'],
            ['Voting body', `${bodyLabel(m.body)}, round ${m.round}`],
            ['Options', m.options.join(' / ')],
            ...(open && m.deadline ? [['Deadline', `${new Date(m.deadline).toLocaleString()} (${timeLeft(m.deadline)})`] as [string, string]] : []),
            ...(d.parties.length > 0 ? [['Parties (cannot vote)', d.parties.map(name).join(', ')] as [string, string]] : []),
            ...(m.state === 'closed' && m.status === 'decided'
              ? [['Result', `${m.outcome_option}${m.decided_final_reason ? ` (recorded by an Admin: ${m.decided_final_reason})` : ''}`] as [string, string]]
              : []),
            ...(m.status === 'withdrawn' ? [['Withdrawn', m.withdraw_reason ?? ''] as [string, string]] : []),
          ]}
        />
      </Panel>

      {open && isVoter && (
        <Panel title="Your vote">
          <p className="odz-muted" style={{ marginBottom: '0.5rem' }}>
            {mine ? `You voted ${mine.option}. You can change it until the motion closes.` : 'You have not voted yet.'}
          </p>
          <div className="odz-row">
            {m.options.map((o) => (
              <Button key={o} variant={mine?.option === o ? 'accent' : 'sec'} disabled={busy} onClick={() => void run(() => supabase!.rpc('cast_vote', { p_motion: m.id, p_option: o }))}>
                {o}
              </Button>
            ))}
          </div>
          {!mine && (
            <div className="odz-stack" style={{ marginTop: '1rem' }}>
              <Textarea label="Reason to recuse" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} hint="A conflict of interest. The reason is recorded." />
              <ConfirmAction label="Recuse myself" onConfirm={() => run(() => supabase!.rpc('recuse_from_motion', { p_motion: m.id, p_reason: reason }))} />
            </div>
          )}
        </Panel>
      )}
      {open && !isVoter && self && (
        <p className="odz-muted" style={{ margin: '0.75rem 0' }}>
          You are not an eligible voter on this motion.
        </p>
      )}

      <Panel title={`Votes, round ${m.round} (${roundVotes.length} of ${d.voters.length} cast)`}>
        <Table
          rows={m.options.map((o) => ({ option: o, n: counts[o] ?? 0 }))}
          rowKey={(r) => r.option}
          columns={[
            { header: 'Option', render: (r) => r.option },
            { header: 'Votes', render: (r) => r.n },
            { header: 'By', render: (r) => roundVotes.filter((v) => v.option === r.option).map(voterName).join(', ') || '-' },
          ]}
        />
        {d.voters.length > 0 && (
          <p className="odz-muted" style={{ marginTop: '0.5rem' }}>
            Not voted yet: {d.voters.filter((p) => !roundVotes.some((v) => v.voter_id === p)).map(name).join(', ') || 'nobody'}
          </p>
        )}
        {d.recusals.length > 0 && (
          <p className="odz-muted" style={{ marginTop: '0.5rem' }}>
            Recused: {d.recusals.map((r) => `${r.callsign ?? 'Former member'} (${r.reason})`).join('; ')}
          </p>
        )}
      </Panel>

      {m.status === 'escalated_final' && isAdmin && (
        <Panel title="Record the outcome (Admin)">
          <div className="odz-stack">
            <Select
              label="Outcome"
              value={finalOption}
              onChange={(e) => setFinalOption(e.target.value)}
              options={[{ value: '', label: 'Choose' }, ...m.options.map((o) => ({ value: o, label: o }))]}
            />
            <Textarea label="Reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint="Recorded with the outcome." />
            <ConfirmAction
              label="Record outcome"
              disabled={!finalOption}
              onConfirm={() => run(() => supabase!.rpc('decide_motion_final', { p_motion: m.id, p_option: finalOption, p_reason: reason }))}
            />
          </div>
        </Panel>
      )}
      {m.status === 'escalated_final' && !isAdmin && (
        <p className="odz-muted" style={{ margin: '0.75rem 0' }}>
          No decision was reached. An Admin records the outcome.
        </p>
      )}

      {m.state === 'draft' && (m.opened_by === self || isAdmin || tierName === 'Command') && (
        <Panel title="Draft">
          <Button disabled={busy} onClick={() => void run(() => supabase!.rpc('start_motion', { p_motion: m.id }))}>
            Open for voting
          </Button>
        </Panel>
      )}

      {canWithdraw && (
        <Panel title="Withdraw">
          <div className="odz-stack">
            <Textarea label="Reason to withdraw" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
            <ConfirmAction label="Withdraw motion" onConfirm={() => run(() => supabase!.rpc('withdraw_motion', { p_motion: m.id, p_reason: reason }))} />
          </div>
        </Panel>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--alert)', margin: '0.75rem 0' }}>
          {error}
        </p>
      )}

      <Panel title="Record">
        <Table
          rows={d.log}
          rowKey={(r) => r.id}
          columns={[
            { header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
            { header: 'Who', render: (r) => r.actor_callsign ?? 'system' },
            {
              header: 'What',
              render: (r) =>
                `${ACTION_WORDS[r.action] ?? r.action}${r.option_from || r.option_to ? `: ${r.option_from ? r.option_from + ' to ' : ''}${r.option_to ?? ''}` : ''}${r.detail && r.action !== 'created' ? ` (${r.detail})` : ''}`,
            },
          ]}
        />
      </Panel>
    </>
  )
}
