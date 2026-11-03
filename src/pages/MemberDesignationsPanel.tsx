import { useState } from 'react'
import { Button, Chip, Panel, Select } from '../components'
import { adminMessage } from '../lib/admin'
import { assignableTo, type Designation, type MemberDesignation } from '../lib/designations'
import { supabase } from '../lib/supabase'

type Props = {
  profileId: string
  catalog: Designation[]
  assignments: MemberDesignation[]
  canEdit: boolean
  onChange: () => void
}

/**
 * A member's duty-role badges (MVA-220). Admin/Command (edit_roster) can assign or revoke; the
 * database enforces eligibility and the holder cap, so this only offers what might work.
 */
export function MemberDesignationsPanel({ profileId, catalog, assignments, canEdit, onChange }: Props) {
  const held = catalog.filter((d) => assignments.some((a) => a.profile_id === profileId && a.designation_id === d.id))
  const assignable = assignableTo(profileId, assignments, catalog)
  const [pick, setPick] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function assign() {
    if (!supabase || !pick) return
    setError(null)
    const { error: err } = await supabase.rpc('assign_designation', { p_profile: profileId, p_designation: pick })
    if (err) {
      setError(adminMessage(err))
      return
    }
    setPick('')
    onChange()
  }

  async function revoke(designationId: string) {
    if (!supabase) return
    setError(null)
    const { error: err } = await supabase.rpc('revoke_designation', { p_profile: profileId, p_designation: designationId })
    if (err) {
      setError(adminMessage(err))
      return
    }
    onChange()
  }

  return (
    <Panel title="Designations">
      {held.length === 0 ? (
        <p className="odz-muted">No designations held.</p>
      ) : (
        <div className="odz-stack">
          {held.map((d) => (
            <div key={d.id} className="odz-row" style={{ justifyContent: 'space-between' }}>
              <Chip variant="accent">{d.name}</Chip>
              {canEdit && (
                <Button small variant="sec" onClick={() => revoke(d.id)}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
      {canEdit && assignable.length > 0 && (
        <div className="odz-row" style={{ marginTop: '1rem' }}>
          <Select
            label="Assign a designation"
            hideLabel
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            options={[{ value: '', label: 'Assign a designation...' }, ...assignable.map((d) => ({ value: d.id, label: d.name }))]}
          />
          <Button disabled={!pick} onClick={assign}>
            Assign
          </Button>
        </div>
      )}
    </Panel>
  )
}
