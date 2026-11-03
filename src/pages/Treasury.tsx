import { useMemo, useState } from 'react'
import { Button, Chip, ConfirmAction, Field, Panel, Select, Table, Textarea } from '../components'
import {
  BANNER,
  bucketLabel,
  CATEGORIES,
  filterEntries,
  formatCents,
  NO_FILTER,
  parseAmount,
  toCsv,
  treasuryMessage,
  type Entry,
  type Fund,
  type LedgerFilter,
} from '../lib/treasury'
import { supabase } from '../lib/supabase'
import { useLoad } from '../lib/useLoad'

type Access = 'none' | 'own' | 'full'
type BalanceRow = { kind: 'fund' | 'member'; id: string; name: string; balance_cents: number }
type Recon = { external_in: number; external_out: number; net_external: number; member_total: number; fund_total: number; ok: boolean }
type Member = { id: string; callsign: string }

const ENTRY_COLUMNS =
  'id,entry_date,amount_cents,from_kind,from_member,from_fund,from_callsign,to_kind,to_member,to_fund,to_callsign,category,note,reverses,entered_by_callsign,created_at'

async function load() {
  const acc = await supabase!.rpc('treasury_access')
  const access = (acc.data ?? 'none') as Access
  if (access === 'none') return { access, entries: [] as Entry[], funds: [] as Fund[], balance: 0, balances: [] as BalanceRow[], recon: null as Recon | null, members: [] as Member[], canManage: false }
  const [entries, funds, bal, canManage] = await Promise.all([
    supabase!.from('treasury_entries').select(ENTRY_COLUMNS).order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000),
    supabase!.from('treasury_funds').select('id,name').order('name'),
    supabase!.rpc('treasury_my_balance'),
    supabase!.rpc('treasury_can_manage'),
  ])
  if (entries.error || funds.error) throw new Error('treasury')
  let balances: BalanceRow[] = []
  let recon: Recon | null = null
  let members: Member[] = []
  if (access === 'full') {
    const [b, r, m] = await Promise.all([
      supabase!.rpc('treasury_balances'),
      supabase!.rpc('treasury_reconcile'),
      supabase!.from('profiles').select('id,callsign').eq('status', 'approved').order('callsign'),
    ])
    balances = (b.data ?? []) as BalanceRow[]
    recon = ((Array.isArray(r.data) ? r.data[0] : r.data) ?? null) as Recon | null
    members = (m.data ?? []) as Member[]
  }
  return {
    access,
    entries: (entries.data ?? []) as unknown as Entry[],
    funds: (funds.data ?? []) as Fund[],
    balance: Number(bal.data ?? 0),
    balances,
    recon,
    members,
    canManage: canManage.data === true,
  }
}

/**
 * Treasury (MVA-216): a tracking-only ledger. Members see their own entries and stored balance;
 * Old Guard and Command see everything. The database decides every one of those; this page shows
 * what it was allowed to read.
 */
export default function Treasury() {
  const data = useLoad(load)
  const [filter, setFilter] = useState<LedgerFilter>(NO_FILTER)
  const d = data.data
  const visible = useMemo(() => filterEntries(d?.entries ?? [], filter), [d, filter])

  if (data.loading) {
    return (
      <p className="odz-muted" role="status">
        Loading
      </p>
    )
  }
  if (data.failed || !d) return <p role="alert">Could not load the treasury.</p>

  const reversedIds = new Set(d.entries.filter((e) => e.reverses).map((e) => e.reverses as string))
  const bucketOptions = [
    { value: '', label: 'Any' },
    ...d.funds.map((f) => ({ value: `fund:${f.id}`, label: `Fund: ${f.name}` })),
    ...(d.access === 'full' ? d.members.map((m) => ({ value: `member:${m.id}`, label: `Member: ${m.callsign}` })) : []),
  ]

  function exportCsv() {
    if (!d) return
    const blob = new Blob([toCsv(visible, d.funds)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'treasury-ledger.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <h1 className="odz-title">Treasury</h1>
      <p role="note" className="odz-panel" style={{ padding: '0.75rem 1rem', marginBottom: '1rem' }}>
        <strong>{BANNER}</strong>
      </p>

      {d.access === 'none' ? (
        <p className="odz-muted">The treasury is not open yet.</p>
      ) : (
        <>
          <Panel title="Your stored balance" action={<Chip variant="plain">{d.access === 'full' ? 'FULL VIEW' : 'YOUR ENTRIES'}</Chip>}>
            <p style={{ fontSize: '1.5rem' }} aria-label="Your stored balance">
              {formatCents(d.balance)}
            </p>
            <p className="odz-muted">What the team record says is held for you. The money itself is in the bank.</p>
          </Panel>

          {d.access === 'full' && (
            <>
              <Panel title="Team coffers">
                {d.balances.filter((b) => b.kind === 'fund').length === 0 ? (
                  <p className="odz-muted">No funds yet.</p>
                ) : (
                  <Table
                    rows={d.balances.filter((b) => b.kind === 'fund')}
                    rowKey={(b) => b.id}
                    columns={[
                      { header: 'Fund', kind: 'cs', render: (b) => b.name },
                      { header: 'Balance', kind: 'status', render: (b) => formatCents(Number(b.balance_cents)) },
                    ]}
                  />
                )}
                {d.recon && (
                  <p style={{ marginTop: '0.75rem' }}>
                    Coffers total: <strong>{formatCents(Number(d.recon.fund_total))}</strong>
                  </p>
                )}
                {d.canManage && <FundTools funds={d.funds} onDone={() => void data.reload()} />}
              </Panel>

              <Panel title="Member stored balances">
                {d.balances.filter((b) => b.kind === 'member').length === 0 ? (
                  <p className="odz-muted">No member holds a balance.</p>
                ) : (
                  <Table
                    rows={d.balances.filter((b) => b.kind === 'member')}
                    rowKey={(b) => b.id}
                    columns={[
                      { header: 'Member', kind: 'cs', render: (b) => b.name },
                      { header: 'Balance', kind: 'status', render: (b) => formatCents(Number(b.balance_cents)) },
                    ]}
                  />
                )}
              </Panel>

              {d.recon && (
                <Panel title="Reconciliation" action={<Chip variant={d.recon.ok ? 'accent' : 'pending'}>{d.recon.ok ? 'RECONCILES' : 'MISMATCH'}</Chip>}>
                  <p>
                    In {formatCents(Number(d.recon.external_in))} minus out {formatCents(Number(d.recon.external_out))} ={' '}
                    {formatCents(Number(d.recon.net_external))}.
                  </p>
                  <p>
                    Members {formatCents(Number(d.recon.member_total))} plus coffers {formatCents(Number(d.recon.fund_total))} ={' '}
                    {formatCents(Number(d.recon.member_total) + Number(d.recon.fund_total))}.
                  </p>
                </Panel>
              )}

              {d.canManage && <RecordEntry funds={d.funds} members={d.members} onDone={() => void data.reload()} />}
            </>
          )}

          <Panel title="Ledger">
            <div className="odz-stack" style={{ marginBottom: '0.75rem' }}>
              <Field label="From date" type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />
              <Field label="To date" type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />
              {bucketOptions.length > 1 && (
                <Select label="Bucket" value={filter.bucket} onChange={(e) => setFilter({ ...filter, bucket: e.target.value })} options={bucketOptions} />
              )}
              <Select
                label="Category"
                value={filter.category}
                onChange={(e) => setFilter({ ...filter, category: e.target.value })}
                options={[{ value: '', label: 'Any' }, ...[...CATEGORIES, 'reversal'].map((c) => ({ value: c, label: c }))]}
              />
              <div className="odz-row">
                <Button variant="sec" small onClick={() => setFilter(NO_FILTER)}>
                  Clear filters
                </Button>
                {d.access === 'full' && (
                  <Button variant="sec" small onClick={exportCsv} disabled={visible.length === 0}>
                    Export CSV
                  </Button>
                )}
              </div>
            </div>
            {visible.length === 0 ? (
              <p className="odz-muted">No entries here.</p>
            ) : (
              <Table
                rows={visible}
                rowKey={(e) => e.id}
                columns={[
                  { header: 'Date', render: (e) => e.entry_date },
                  { header: 'Amount', kind: 'status', render: (e) => formatCents(e.amount_cents) },
                  { header: 'From', render: (e) => bucketLabel(e.from_kind, e.from_callsign, e.from_fund, d.funds) },
                  { header: 'To', render: (e) => bucketLabel(e.to_kind, e.to_callsign, e.to_fund, d.funds) },
                  {
                    header: 'Category',
                    render: (e) => (
                      <>
                        {e.category}
                        {e.reverses && <span className="odz-muted"> (reverses an entry)</span>}
                        {reversedIds.has(e.id) && <span className="odz-muted"> (reversed)</span>}
                      </>
                    ),
                  },
                  { header: 'Note', render: (e) => e.note || '-' },
                  {
                    header: 'Action',
                    render: (e) =>
                      d.canManage && !e.reverses && !reversedIds.has(e.id) ? <ReverseButton entry={e} onDone={() => void data.reload()} /> : '-',
                  },
                ]}
              />
            )}
          </Panel>
        </>
      )}
    </>
  )
}

function ReverseButton({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!asking) {
    return (
      <Button variant="sec" small onClick={() => setAsking(true)} aria-label={`Reverse entry of ${formatCents(entry.amount_cents)}`}>
        Reverse
      </Button>
    )
  }
  return (
    <div className="odz-stack">
      <Textarea label="Reason (required)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <ConfirmAction
        label="Reverse"
        confirmLabel="Confirm reversal"
        variant="accent"
        onConfirm={async () => {
          setError(null)
          const { error: err } = await supabase!.rpc('treasury_reverse', { p_entry: entry.id, p_note: note })
          if (err) return setError(treasuryMessage(err.message))
          onDone()
        }}
      />
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

function FundTools({ funds, onDone }: { funds: Fund[]; onDone: () => void }) {
  const [name, setName] = useState('')
  const [rename, setRename] = useState('')
  const [renameName, setRenameName] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, after: () => void) {
    setError(null)
    const { error: err } = await fn()
    if (err) return setError(treasuryMessage(err.message))
    after()
    onDone()
  }
  return (
    <div className="odz-stack" style={{ marginTop: '1rem' }}>
      <span className="odz-label">Funds</span>
      <Field label="New fund name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <Button variant="sec" disabled={name.trim().length < 2} onClick={() => void run(() => supabase!.rpc('treasury_create_fund', { p_name: name }), () => setName(''))}>
        Add fund
      </Button>
      {funds.length > 0 && (
        <>
          <Select
            label="Rename fund"
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            options={[{ value: '', label: 'Choose' }, ...funds.map((f) => ({ value: f.id, label: f.name }))]}
          />
          <Field label="New name" value={renameName} maxLength={60} onChange={(e) => setRenameName(e.target.value)} />
          <Button
            variant="sec"
            disabled={!rename || renameName.trim().length < 2}
            onClick={() =>
              void run(
                () => supabase!.rpc('treasury_rename_fund', { p_fund: rename, p_name: renameName }),
                () => {
                  setRename('')
                  setRenameName('')
                },
              )
            }
          >
            Rename fund
          </Button>
        </>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

function parseBucket(v: string): { kind: 'external' | 'member' | 'fund'; id: string | null } | null {
  if (v === 'external') return { kind: 'external', id: null }
  const [kind, id] = v.split(':')
  return (kind === 'member' || kind === 'fund') && id ? { kind, id } : null
}

function RecordEntry({ funds, members, onDone }: { funds: Fund[]; members: Member[]; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [amount, setAmount] = useState('')
  const [from, setFrom] = useState('external')
  const [to, setTo] = useState('')
  const [category, setCategory] = useState<string>('deposit')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const buckets = [
    { value: 'external', label: 'Outside (bank, cash)' },
    ...funds.map((f) => ({ value: `fund:${f.id}`, label: `Fund: ${f.name}` })),
    ...members.map((m) => ({ value: `member:${m.id}`, label: `Member: ${m.callsign}` })),
  ]

  async function submit() {
    setError(null)
    const a = parseAmount(amount)
    if (!a.ok) return setError('Enter an amount like 25 or 25.50.')
    const f = parseBucket(from)
    const t = parseBucket(to)
    if (!f || !t) return setError('Choose where the money comes from and goes to.')
    setBusy(true)
    const { error: err } = await supabase!.rpc('treasury_record', {
      p_date: date,
      p_amount_cents: a.cents,
      p_from_kind: f.kind,
      p_from_id: f.id,
      p_to_kind: t.kind,
      p_to_id: t.id,
      p_category: category,
      p_note: note,
    })
    setBusy(false)
    if (err) return setError(treasuryMessage(err.message))
    setAmount('')
    setNote('')
    onDone()
  }

  return (
    <Panel title="Record an entry">
      <div className="odz-stack">
        <Field label="Date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        <Field label="Amount (dollars)" hint="For example 25 or 25.50" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Select label="From" value={from} onChange={(e) => setFrom(e.target.value)} options={buckets} />
        <Select label="To" value={to} onChange={(e) => setTo(e.target.value)} options={[{ value: '', label: 'Choose' }, ...buckets]} />
        <Select label="Entry category" value={category} onChange={(e) => setCategory(e.target.value)} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        <Textarea label="Entry note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <Button variant="accent" disabled={busy} onClick={() => void submit()}>
          Record entry
        </Button>
        {error && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {error}
          </p>
        )}
      </div>
    </Panel>
  )
}
