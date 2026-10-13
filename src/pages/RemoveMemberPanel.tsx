import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Chip, ConfirmAction, Panel, Textarea } from '../components'
import { adminMessage } from '../lib/admin'
import { counter } from '../lib/roster'
import { REASON_MAX, removalBlock, validateReason, type RemovalTarget } from '../lib/removal'
import { supabase } from '../lib/supabase'

type Props = {
  callsign: string
  target: RemovalTarget
  selfId: string | undefined
  approvedAdmins: number
}

/**
 * Admin-only. Soft removal: the account loses access, private details are purged, the roster
 * entry goes, what the member wrote stays under "Former member". The database refuses anyone
 * who is not an Admin; this panel only decides what to offer.
 */
export function RemoveMemberPanel({ callsign, target, selfId, approvedAdmins }: Props) {
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const blocked = removalBlock({ isAdmin: true, selfId, target, approvedAdmins })
  const invalid = validateReason(reason)

  async function remove() {
    if (!supabase || invalid) return
    setError(null)
    const { error: err } = await supabase.rpc('remove_member', { p_profile: target.id, p_reason: reason.trim() })
    if (err) {
      setError(adminMessage(err))
      return
    }
    void navigate('/roster', { replace: true })
  }

  return (
    <Panel title="Remove member" action={<Chip variant="alert">ADMIN-ONLY</Chip>}>
      {blocked ? (
        <p className="odz-muted">{blocked}</p>
      ) : (
        <div className="odz-stack">
          <p>
            {`Removing ${callsign} ends their access now and deletes their private details. They leave the roster; what they wrote stays, shown as "Former member". This is logged with your reason, which only Admins can read.`}
          </p>
          <Textarea
            label="Reason (required)"
            value={reason}
            maxLength={REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            hint={counter(reason, REASON_MAX)}
          />
          {error && (
            <p role="alert" style={{ color: 'var(--alert)' }}>
              {error}
            </p>
          )}
          <div>
            <ConfirmAction
              label="Remove member"
              confirmLabel={`Confirm: remove ${callsign}`}
              variant="sec"
              small={false}
              disabled={invalid !== null}
              onConfirm={remove}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}
