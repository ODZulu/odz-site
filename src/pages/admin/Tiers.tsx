import { useState, type FormEvent } from 'react'
import { Button, Chip, ConfirmAction, Field, Panel } from '../../components'
import {
  adminMessage,
  confirmMatches,
  CONFIRM_WORD,
  moveId,
  needsTypedConfirm,
  removalLocksOut,
  type CapMatrix,
} from '../../lib/admin'
import { supabase } from '../../lib/supabase'
import { ROLE_BASED_NOTE } from '../../lib/tiers'
import { useLoad } from '../../lib/useLoad'

type TierRow = {
  id: string
  name: string
  rank: number
  entry_requires_tier_id: string | null
  release_to_tier_id: string | null
  role_based: boolean
}
type CapRow = { key: string; description: string }
type Data = { tiers: TierRow[]; caps: CapRow[]; matrix: CapMatrix; members: Record<string, number> }

/** Admin only. Tiers and capabilities change through RPCs; every rule is enforced in the database. */
export default function Tiers() {
  const data = useLoad<Data>(async () => {
    const c = supabase!
    const [t, k, tc, p] = await Promise.all([
      c.from('tiers').select('id,name,rank,entry_requires_tier_id,release_to_tier_id,role_based').order('rank'),
      c.from('capabilities').select('key,description').order('key'),
      c.from('tier_capabilities').select('tier_id,capability_key'),
      c.from('profiles').select('tier_id').eq('status', 'approved'),
    ])
    if (t.error || k.error || tc.error || p.error) throw new Error('load')
    const matrix: CapMatrix = {}
    for (const row of t.data as TierRow[]) matrix[row.id] = []
    for (const row of tc.data as Array<{ tier_id: string; capability_key: string }>) matrix[row.tier_id]?.push(row.capability_key)
    const members: Record<string, number> = {}
    for (const row of p.data as Array<{ tier_id: string | null }>) if (row.tier_id) members[row.tier_id] = (members[row.tier_id] ?? 0) + 1
    return { tiers: t.data as TierRow[], caps: k.data as CapRow[], matrix, members }
  })

  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  // A pending change to view_member_private waits here for the typed word.
  const [typed, setTyped] = useState<{ tier: string; tierName: string; enabled: boolean; word: string } | null>(null)

  async function run(fn: string, args: Record<string, unknown>): Promise<boolean> {
    if (!supabase) return false
    setError(null)
    const { error: err } = await supabase.rpc(fn, args)
    if (err) setError(adminMessage(err))
    await data.reload()
    return !err
  }

  async function toggle(tier: TierRow, cap: string, enabled: boolean) {
    const d = data.data
    if (!d) return
    if (!enabled && removalLocksOut(d.matrix, tier.id, cap)) {
      setError('Approving members must stay switched on for at least one tier.')
      return
    }
    if (needsTypedConfirm(cap)) {
      setTyped({ tier: tier.id, tierName: tier.name, enabled, word: '' })
      return
    }
    await run('set_tier_capability', { p_tier: tier.id, p_cap: cap, p_enabled: enabled })
  }

  async function confirmTyped(e: FormEvent) {
    e.preventDefault()
    if (!typed || !confirmMatches(typed.word)) return
    const t = typed
    setTyped(null)
    await run('set_tier_capability', { p_tier: t.tier, p_cap: 'view_member_private', p_enabled: t.enabled, p_confirm: t.word })
  }

  async function addTier(e: FormEvent) {
    e.preventDefault()
    if (await run('create_tier', { p_name: newName })) setNewName('')
  }

  async function saveRename(e: FormEvent) {
    e.preventDefault()
    if (!renaming) return
    const r = renaming
    setRenaming(null)
    await run('rename_tier', { p_id: r.id, p_name: r.name })
  }

  async function move(id: string, dir: 'up' | 'down') {
    const d = data.data
    if (!d) return
    const ids = d.tiers.map((t) => t.id)
    const next = moveId(ids, id, dir)
    if (next === ids) return
    await run('reorder_tiers', { p_ids: next })
  }

  const d = data.data

  return (
    <div className="odz-stack">
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}

      {typed && (
        <Panel title="Confirm private-details access" action={<Chip variant="alert">PRIVATE</Chip>}>
          <form onSubmit={confirmTyped} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p>
              {typed.enabled ? 'Allow' : 'Stop allowing'} the {typed.tierName} tier to read members&apos; private details (date of
              birth, allergies, emergency contacts). Type {CONFIRM_WORD} to confirm.
            </p>
            <Field label={`Type ${CONFIRM_WORD}`} autoComplete="off" value={typed.word} onChange={(e) => setTyped({ ...typed, word: e.target.value })} />
            <div className="odz-row">
              <Button type="submit" variant="accent" disabled={!confirmMatches(typed.word)}>
                Confirm
              </Button>
              <Button variant="ghost" onClick={() => setTyped(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {data.loading ? (
        <p className="odz-muted" role="status">
          Loading
        </p>
      ) : data.failed || !d ? (
        <p role="alert">Could not load tiers.</p>
      ) : (
        d.tiers.map((t, i) => {
          const hasRules = t.entry_requires_tier_id !== null || t.release_to_tier_id !== null
          const count = d.members[t.id] ?? 0
          return (
            <Panel
              key={t.id}
              title={`${i + 1}. ${t.name}`}
              action={<Chip variant="plain">{`${count} MEMBER${count === 1 ? '' : 'S'}`}</Chip>}
            >
              <div className="odz-row" style={{ marginBottom: '0.75rem' }}>
                <Button small variant="sec" disabled={i === 0} onClick={() => void move(t.id, 'up')} aria-label={`Move ${t.name} up`}>
                  Up
                </Button>
                <Button small variant="sec" disabled={i === d.tiers.length - 1} onClick={() => void move(t.id, 'down')} aria-label={`Move ${t.name} down`}>
                  Down
                </Button>
                {renaming?.id === t.id ? (
                  <form onSubmit={saveRename} className="odz-row" noValidate>
                    <Field label="New name" maxLength={30} value={renaming.name} onChange={(e) => setRenaming({ id: t.id, name: e.target.value })} />
                    <Button type="submit" small>
                      Save
                    </Button>
                    <Button small variant="ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <Button small variant="sec" onClick={() => setRenaming({ id: t.id, name: t.name })}>
                    Rename
                  </Button>
                )}
                {count === 0 && !hasRules && (
                  <ConfirmAction label="Delete" confirmLabel="Confirm delete" onConfirm={() => void run('delete_tier', { p_id: t.id })} />
                )}
              </div>
              {t.role_based && (
                <p className="odz-muted" style={{ marginBottom: '0.75rem' }}>
                  {ROLE_BASED_NOTE}
                </p>
              )}
              {hasRules && (
                <p className="odz-muted" style={{ marginBottom: '0.75rem' }}>
                  Entry and release rules are fixed (Command is entered from Old Guard and releases to Old Guard).
                </p>
              )}
              <div className="odz-capgrid">
                {d.caps.map((c) => {
                  const on = d.matrix[t.id]?.includes(c.key) ?? false
                  return (
                    <label key={c.key} className="odz-check" title={c.description}>
                      <input type="checkbox" checked={on} onChange={(e) => void toggle(t, c.key, e.target.checked)} />
                      <span>{c.key}</span>
                    </label>
                  )
                })}
              </div>
            </Panel>
          )
        })
      )}

      <Panel title="Add tier">
        <form onSubmit={addTier} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Field label="Tier name" maxLength={30} value={newName} onChange={(e) => setNewName(e.target.value)} hint="New tiers start at the bottom with no capabilities." />
          <Button type="submit" disabled={!newName.trim()}>
            Add tier
          </Button>
        </form>
      </Panel>
    </div>
  )
}
