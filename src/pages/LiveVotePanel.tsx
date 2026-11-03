import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Button, Chip, ConfirmAction, Select, Textarea } from '../components'
import {
  currentMotion,
  LIVE_OPTIONS,
  liveMessage,
  outstanding,
  RESULT_LABEL,
  validateRecord,
  votingState,
  type LiveResult,
} from '../lib/liveVote'
import { supabase } from '../lib/supabase'
import { useLoad } from '../lib/useLoad'

type LiveMotion = {
  id: string
  status: string
  state: 'draft' | 'open' | 'closed'
  created_at: string
  live_closed_at: string | null
  live_result: LiveResult | null
  outcome_option: string | null
  quorum_at_open: number | null
}
type Progress = {
  eligible: number
  voted: number
  consulted: number
  advisory_voted: number
  quorum: number | null
  is_voter: boolean
  is_consulted: boolean
  my_vote: string | null
  my_advisory: string | null
  closed: boolean
}
type VoteRow = { voter_id: string; voter_callsign: string | null; option: string; recorded_by: string | null; record_note: string | null }
type Member = { id: string; callsign: string }

async function load(itemId: string) {
  const m = await supabase!
    .from('motions')
    .select('id,status,state,created_at,live_closed_at,live_result,outcome_option,quorum_at_open')
    .eq('parent_type', 'agenda_item')
    .eq('parent_id', itemId)
  if (m.error) throw new Error('vote')
  const motion = currentMotion((m.data ?? []) as LiveMotion[])
  if (!motion) return { motion: null, progress: null, votes: [], advisory: [], voters: [] as string[] }
  const [p, votes, adv, voters] = await Promise.all([
    supabase!.rpc('live_vote_progress', { p_motion: motion.id }),
    supabase!.from('motion_votes').select('voter_id,voter_callsign,option,recorded_by,record_note').eq('motion_id', motion.id),
    supabase!.from('motion_advisory_votes').select('callsign,option').eq('motion_id', motion.id),
    supabase!.from('motion_voters').select('profile_id').eq('motion_id', motion.id).eq('round', 1),
  ])
  const progress = (Array.isArray(p.data) ? p.data[0] : p.data) as Progress | null
  return {
    motion,
    progress: progress ?? null,
    votes: (votes.data ?? []) as VoteRow[],
    advisory: (adv.data ?? []) as { callsign: string | null; option: string }[],
    voters: ((voters.data ?? []) as { profile_id: string }[]).map((v) => v.profile_id),
  }
}

/**
 * The live vote of one agenda vote item (MVA-246): the chair opens and closes it; eligible voters
 * cast Yes / No / Abstain; choices stay hidden until the chair closes. The database enforces every
 * rule; this panel shows what the rows it was allowed to read say.
 */
export function LiveVotePanel({ itemId, canChair, members, hasWording }: { itemId: string; canChair: boolean; members: Member[]; hasWording: boolean }) {
  const data = useLoad(() => load(itemId), [itemId])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recFor, setRecFor] = useState('')
  const [recOption, setRecOption] = useState('Yes')
  const [recNote, setRecNote] = useState('')
  const open = data.data ? votingState(data.data.motion) === 'open' : false

  // The page is not realtime: while a vote is open, refresh the counts every few seconds.
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => void data.reload(), 5000)
    return () => clearInterval(t)
  }, [open, data])

  if (data.loading) return null
  const d = data.data
  if (data.failed || !d) return null
  const state = votingState(d.motion)
  const motion = d.motion
  const p = d.progress

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) {
    setError(null)
    setBusy(true)
    const { error: err } = await fn()
    setBusy(false)
    if (err) return setError(liveMessage(err.message))
    after?.()
    await data.reload()
  }

  const nameOf = (id: string) => members.find((m) => m.id === id)?.callsign ?? 'Former member'
  const tally = (o: string) => d.votes.filter((v) => v.option === o).length

  return (
    <div className="odz-panel" style={{ marginTop: '0.75rem' }}>
      <div className="odz-panel__h">
        <h3 className="odz-label">Live vote</h3>
        <Chip variant={state === 'open' ? 'accent' : state === 'closed' ? 'plain' : 'pending'}>
          {state === 'not_opened' ? 'NOT OPENED' : state === 'open' ? 'VOTING OPEN' : 'CLOSED'}
        </Chip>
      </div>
      <div className="odz-panel__b odz-stack">
        {state === 'not_opened' &&
          (canChair ? (
            <>
              <p className="odz-muted">
                Opening freezes the wording and snapshots who can vote: Old Guard and Command. Members are consulted.
              </p>
              <Button
                variant="accent"
                disabled={busy || !hasWording}
                onClick={() => void run(() => supabase!.rpc('open_live_vote', { p_item: itemId }))}
              >
                Open vote
              </Button>
              {!hasWording && <p className="odz-muted">Add the exact motion wording to this item first.</p>}
            </>
          ) : (
            <p className="odz-muted">The chair has not opened voting yet.</p>
          ))}

        {state === 'open' && motion && p && (
          <>
            <p>
              {p.voted} of {p.eligible} eligible voters have voted ({outstanding(p.eligible, p.voted)} to go).
              {p.quorum !== null && ` Quorum: ${p.quorum} votes.`}
            </p>
            <p className="odz-muted">Choices are hidden until the chair closes the vote.</p>
            {p.is_voter && (
              <>
                <p>{p.my_vote ? `Your vote: ${p.my_vote}. You can change it until the chair closes.` : 'You have not voted yet.'}</p>
                <div className="odz-row">
                  {LIVE_OPTIONS.map((o) => (
                    <Button
                      key={o}
                      variant={p.my_vote === o ? 'accent' : 'sec'}
                      disabled={busy}
                      onClick={() => void run(() => supabase!.rpc('cast_vote', { p_motion: motion.id, p_option: o }))}
                    >
                      {o}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {p.is_consulted && (
              <>
                <p>
                  Advisory poll (does not count toward the result):{' '}
                  {p.my_advisory ? `you answered ${p.my_advisory}.` : 'not answered yet.'}
                </p>
                <div className="odz-row">
                  {LIVE_OPTIONS.map((o) => (
                    <Button
                      key={o}
                      small
                      variant={p.my_advisory === o ? 'accent' : 'sec'}
                      disabled={busy}
                      aria-label={`Advisory ${o}`}
                      onClick={() => void run(() => supabase!.rpc('cast_advisory_vote', { p_motion: motion.id, p_option: o }))}
                    >
                      {o}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {!p.is_voter && !p.is_consulted && <p className="odz-muted">You are not part of this vote.</p>}
            {canChair && (
              <div className="odz-stack">
                <span className="odz-label">Record a vote for a voter who cannot use the app</span>
                <Select
                  label="Voter"
                  value={recFor}
                  onChange={(e) => setRecFor(e.target.value)}
                  options={[{ value: '', label: 'Choose' }, ...d.voters.map((id) => ({ value: id, label: nameOf(id) }))]}
                />
                <Select
                  label="Choice"
                  value={recOption}
                  onChange={(e) => setRecOption(e.target.value)}
                  options={LIVE_OPTIONS.map((o) => ({ value: o, label: o }))}
                />
                <Textarea label="Note (required)" value={recNote} maxLength={300} onChange={(e) => setRecNote(e.target.value)} hint="Why the chair is recording it. Shown in the record." />
                <Button
                  variant="sec"
                  disabled={busy}
                  onClick={() => {
                    const bad = validateRecord(recFor, recOption, recNote)
                    if (bad) return setError(bad)
                    void run(
                      () => supabase!.rpc('record_vote_for', { p_motion: motion.id, p_voter: recFor, p_option: recOption, p_note: recNote }),
                      () => {
                        setRecFor('')
                        setRecNote('')
                      },
                    )
                  }}
                >
                  Record vote
                </Button>
                <ConfirmAction
                  label="Close vote"
                  variant="accent"
                  confirmLabel="Confirm close and reveal"
                  onConfirm={() => run(() => supabase!.rpc('close_live_vote', { p_motion: motion.id }))}
                />
              </div>
            )}
          </>
        )}

        {state === 'closed' && motion && (
          <>
            <p>
              <strong>{motion.live_result ? RESULT_LABEL[motion.live_result] : 'Closed'}</strong>
              {motion.status === 'decided' && motion.outcome_option ? ` (${motion.outcome_option})` : ''}
            </p>
            {motion.status === 'escalated_final' && (
              <p className="odz-muted">
                No decision. An Admin records the outcome on the <Link to={`/motions/${motion.id}`}>motion page</Link>.
              </p>
            )}
            <p>
              Yes {tally('Yes')}, No {tally('No')}, Abstain {tally('Abstain')}
              {p ? ` of ${p.eligible} eligible` : ''}
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              {[...d.votes]
                .sort((a, b) => (a.voter_callsign ?? '').localeCompare(b.voter_callsign ?? ''))
                .map((v) => (
                  <li key={v.voter_id}>
                    {v.voter_callsign ?? nameOf(v.voter_id)}: {v.option}
                    {v.recorded_by && <span className="odz-muted"> (recorded by chair: {v.record_note})</span>}
                  </li>
                ))}
            </ul>
            {d.advisory.length > 0 && (
              <p className="odz-muted">
                Advisory poll, not counted: Yes {d.advisory.filter((a) => a.option === 'Yes').length}, No{' '}
                {d.advisory.filter((a) => a.option === 'No').length}, Abstain {d.advisory.filter((a) => a.option === 'Abstain').length}
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
