import { useState } from 'react'
import { canRsvp, groupRsvps, loadReadiness, loadRsvps, RSVP_LABEL, saveRsvp, type Rsvp } from '../lib/hq'
import { useLoad } from '../lib/useLoad'
import { useAuth } from '../auth/AuthProvider'
import { Button } from './Button'
import { ReadinessMeter } from './ReadinessMeter'

/** IN / OUT / TBD for one event, plus who answered what. Members only (RLS); shown on the event detail. */
export function RsvpPanel({ event }: { event: { id: string; starts_at: string; status: string } }) {
  const { session } = useAuth()
  const me = session?.user.id
  const rsvps = useLoad(() => loadRsvps(event.id), [event.id])
  const readiness = useLoad(() => loadReadiness(event.id), [event.id])
  const [error, setError] = useState<string | null>(null)

  const open = canRsvp(event, new Date())
  const mine = rsvps.data?.find((r) => r.profile_id === me)?.response
  const groups = groupRsvps(rsvps.data ?? [])

  async function answer(r: Rsvp) {
    setError(null)
    try {
      await saveRsvp(event.id, r)
    } catch {
      setError('Could not save your answer.')
    }
    await Promise.all([rsvps.reload(), readiness.reload()])
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      {readiness.data && <ReadinessMeter readiness={readiness.data} />}
      <div className="odz-row" style={{ margin: '0.75rem 0' }} role="group" aria-label="Your answer">
        {(['in', 'out', 'tbd'] as Rsvp[]).map((r) => (
          <Button key={r} small variant={mine === r ? 'primary' : 'sec'} disabled={!open} onClick={() => void answer(r)} aria-pressed={mine === r}>
            {RSVP_LABEL[r]}
          </Button>
        ))}
        {!open && <span className="odz-muted">{event.status === 'cancelled' ? 'Cancelled.' : 'Answers are closed.'}</span>}
      </div>
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
      {(['in', 'out', 'tbd'] as Rsvp[]).map((r) =>
        groups[r].length > 0 ? (
          <p key={r}>
            <span className="odz-label">{`${RSVP_LABEL[r]} (${groups[r].length}) `}</span>
            {groups[r].join(', ')}
          </p>
        ) : null,
      )}
    </div>
  )
}

/** Loads the RSVP panel only when opened, so a long agenda does not fetch every event's answers up front. */
export function RsvpToggle({ event }: { event: { id: string; starts_at: string; status: string } }) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>RSVP and readiness</summary>
      {open && <RsvpPanel event={event} />}
    </details>
  )
}
