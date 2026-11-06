import { useState } from 'react'
import { Button, Chip, ConfirmAction, Panel, Select, Textarea } from '../components'
import { counter } from '../lib/roster'
import {
  isSeatFull,
  isTierMissing,
  PICK_TIER_MESSAGE,
  retireBlock,
  retireMessage,
  retireWarning,
  returnTierOptions,
  validateRetireReason,
  RETIRE_REASON_MAX,
  type RetireTarget,
  type TierOption,
} from '../lib/retire'
import type { SeatCounts } from '../lib/seats'
import { supabase } from '../lib/supabase'

type RetireProps = {
  callsign: string
  target: RetireTarget
  selfId: string | undefined
  canEdit: boolean
  isAdmin: boolean
  /** Names of the designations this member holds now; the warning lists them before anything else. */
  designations: string[]
  onChange: () => void
}

/**
 * Command / Admin (edit_roster). Retiring is the soft state for someone who stopped playing: the
 * account keeps a limited sign-in and the service record, loses duty roles and seats, and can be
 * brought back. The database refuses anyone without edit_roster; this panel only decides what to offer.
 */
export function RetireMemberPanel({ callsign, target, selfId, canEdit, isAdmin, designations, onChange }: RetireProps) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const blocked = retireBlock({ canEdit, isAdmin, selfId, target })
  const invalid = validateRetireReason(reason)

  if (!canEdit) return null

  async function retire() {
    if (!supabase || invalid) return
    setError(null)
    const { error: err } = await supabase.rpc('retire_member', { p_profile: target.id, p_reason: reason.trim() || null })
    if (err) {
      setError(retireMessage(err))
      return
    }
    setReason('')
    onChange()
  }

  return (
    <Panel title="Retire member" action={<Chip variant="plain">COMMAND</Chip>}>
      {blocked ? (
        <p className="odz-muted">{blocked}</p>
      ) : (
        <div className="odz-stack">
          <p>{retireWarning(callsign, designations)}</p>
          <Textarea
            label="Reason (optional)"
            value={reason}
            maxLength={RETIRE_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            hint={counter(reason, RETIRE_REASON_MAX)}
            error={invalid ?? undefined}
          />
          {error && (
            <p role="alert" style={{ color: 'var(--alert)' }}>
              {error}
            </p>
          )}
          <div>
            <ConfirmAction
              label="Retire member"
              confirmLabel={`Confirm: retire ${callsign}`}
              variant="sec"
              small={false}
              disabled={invalid !== null}
              onConfirm={retire}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

type UnretireProps = {
  callsign: string
  profileId: string
  /** The tier this member held when retired (tier_id is unchanged by retirement). */
  currentTierId: string | null
  tierName: string | null
  tiers: TierOption[]
  counts: SeatCounts | null
  canEdit: boolean
  onChange: () => void
}

/**
 * Brings a retired member back in their prior tier. If that tier's seat is full the database
 * refuses with its seat message and Command picks a tier with room (or leaves them retired).
 */
export function UnretireMemberPanel({ callsign, profileId, currentTierId, tierName, tiers, counts, canEdit, onChange }: UnretireProps) {
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  // No tier on record (or the database found none): the database cannot guess, so Command picks one.
  const [needsTier, setNeedsTier] = useState(currentTierId === null)
  const [pick, setPick] = useState('')
  const options = returnTierOptions({ tiers, counts, currentTierId })

  const picking = full || needsTier

  if (!canEdit) return null

  async function unretire(tier: string | null) {
    if (!supabase) return
    setError(null)
    const { error: err } = await supabase.rpc('unretire_member', { p_profile: profileId, p_tier: tier })
    if (err) {
      setFull(isSeatFull(err))
      if (isTierMissing(err)) setNeedsTier(true)
      setError(retireMessage(err))
      return
    }
    setFull(false)
    setNeedsTier(false)
    onChange()
  }

  return (
    <Panel title="Return to the roster" action={<Chip variant="plain">COMMAND</Chip>}>
      <div className="odz-stack">
        <p>{`${callsign} is retired. ${currentTierId === null ? 'Returning needs a tier.' : `Returning puts them back as ${tierName ?? 'their prior tier'}.`} Designations and office seats are not restored; Command reassigns them.`}</p>
        {error && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {error}
          </p>
        )}
        {picking && (
          <div className="odz-stack">
            <p className="odz-muted">
              {full
                ? 'That seat is full. Pick a tier with room, or leave them retired until a seat opens.'
                : `${callsign} has no tier on record. ${PICK_TIER_MESSAGE}.`}
            </p>
            <Select
              label="Return as"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              options={[{ value: '', label: 'Choose a tier' }, ...options.map((t) => ({ value: t.id, label: t.name }))]}
            />
            <div>
              <Button variant="sec" disabled={!pick} onClick={() => void unretire(pick)}>
                Return in this tier
              </Button>
            </div>
          </div>
        )}
        {!picking && (
          <div>
            <ConfirmAction
              label="Return to roster"
              confirmLabel={`Confirm: return ${callsign}`}
              variant="sec"
              small={false}
              onConfirm={() => unretire(null)}
            />
          </div>
        )}
      </div>
    </Panel>
  )
}
