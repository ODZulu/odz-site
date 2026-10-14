import { useState, type FormEvent } from 'react'
import { Button, Chip, ConfirmAction, Field, Panel, Select, Table } from '../../components'
import { adminMessage, EXPIRY_DEFAULT_DAYS, groupCode, joinLink, maskCode, validateExpiryDays } from '../../lib/admin'
import { formatStamp } from '../../lib/format'
import { defaultInviteTier } from '../../lib/tiers'
import { supabase } from '../../lib/supabase'
import { useLoad } from '../../lib/useLoad'

type InviteRow = {
  id: string
  code_hint: string
  tier: string
  note: string | null
  created_by: string | null
  created_at: string
  expires_at: string
  status: 'active' | 'used' | 'expired' | 'revoked'
  used_by: string | null
}
type TierRow = { id: string; name: string; rank: number; invitable: boolean; role_based: boolean }

const statusChip = {
  active: <Chip variant="go">ACTIVE</Chip>,
  used: <Chip variant="plain">USED</Chip>,
  expired: <Chip variant="pending">EXPIRED</Chip>,
  revoked: <Chip variant="alert">REVOKED</Chip>,
} as const

export default function Invites() {
  const invites = useLoad(async () => {
    const { data, error } = await supabase!.rpc('list_invites')
    if (error) throw error
    return data as InviteRow[]
  })
  const tiers = useLoad(async () => {
    const { data, error } = await supabase!.from('tiers').select('id,name,rank,invitable,role_based').order('rank')
    if (error) throw error
    return (data as TierRow[]).filter((t) => t.invitable)
  })

  const [tier, setTier] = useState('')
  const [note, setNote] = useState('')
  const [days, setDays] = useState(String(EXPIRY_DEFAULT_DAYS))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The full code lives only in this state, once. A reload or "Done" loses it for good.
  const [created, setCreated] = useState<{ code: string; link: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const tierOptions = (tiers.data ?? []).map((t) => ({ value: t.id, label: t.name }))
  // Default to the least senior player tier an invite may grant (Recruit), never a role-based one.
  const defaultTier = defaultInviteTier(tiers.data ?? [])

  async function create(e: FormEvent) {
    e.preventDefault()
    const n = Number(days)
    const bad = validateExpiryDays(n)
    if (bad) return setError(bad)
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('create_invite', {
      p_tier: tier || defaultTier || null,
      p_note: note.trim() || null,
      p_days: n,
    })
    setBusy(false)
    if (err || typeof data !== 'string') return setError(adminMessage(err))
    setCreated({ code: data, link: joinLink(window.location.origin, data) })
    setCopied(false)
    setNote('')
    void invites.reload()
  }

  async function revoke(id: string) {
    if (!supabase) return
    const { error: err } = await supabase.from('invites').update({ revoked_at: new Date().toISOString() }).eq('id', id)
    if (err) setError(adminMessage(err))
    void invites.reload()
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="odz-stack">
      {created && (
        <Panel title="New invite" action={<Chip variant="accent">SHOWN ONCE</Chip>}>
          <p className="odz-muted">Copy it now. After you leave this panel only the last four characters are ever shown.</p>
          <p className="odz-code" data-testid="new-invite-code" style={{ margin: '0.75rem 0' }}>
            {groupCode(created.code)}
          </p>
          <p className="odz-muted" style={{ wordBreak: 'break-all' }}>
            {created.link}
          </p>
          <div className="odz-row" style={{ marginTop: '0.75rem' }}>
            <Button small onClick={() => void copy(created.link)}>
              {copied ? 'Link copied' : 'Copy join link'}
            </Button>
            <Button small variant="sec" onClick={() => void copy(created.code)}>
              Copy code
            </Button>
            <Button small variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </Panel>
      )}

      <Panel title="Create invite">
        <form onSubmit={create} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Select
            label="Tier"
            value={tier || defaultTier}
            onChange={(e) => setTier(e.target.value)}
            options={tierOptions}
          />
          <Field label="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} hint="Who it is for. Not shown to them." />
          <Field
            label="Expires in (days)"
            type="number"
            inputMode="numeric"
            min={1}
            max={30}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            hint="1 to 30."
          />
          {error && (
            <p role="alert" style={{ color: 'var(--alert)' }}>
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || tierOptions.length === 0}>
            {busy ? 'Creating' : 'Create invite'}
          </Button>
        </form>
      </Panel>

      <Panel title="Invites">
        {invites.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : invites.failed ? (
          <p role="alert">Could not load invites.</p>
        ) : (invites.data ?? []).length === 0 ? (
          <p className="odz-muted">No invites yet.</p>
        ) : (
          <Table
            rows={invites.data ?? []}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Code', kind: 'cs', render: (r) => maskCode(r.code_hint) },
              { header: 'Tier', render: (r) => r.tier },
              { header: 'Note', render: (r) => r.note ?? '-' },
              { header: 'By', render: (r) => r.created_by ?? '-' },
              { header: 'Created', render: (r) => formatStamp(new Date(r.created_at)) },
              { header: 'Expires', render: (r) => formatStamp(new Date(r.expires_at)) },
              { header: 'Used by', render: (r) => r.used_by ?? '-' },
              { header: 'Status', kind: 'status', render: (r) => statusChip[r.status] },
              {
                header: 'Action',
                render: (r) =>
                  r.status === 'active' ? (
                    <ConfirmAction label="Revoke" confirmLabel="Confirm revoke" onConfirm={() => revoke(r.id)} />
                  ) : null,
              },
            ]}
          />
        )}
      </Panel>
    </div>
  )
}
