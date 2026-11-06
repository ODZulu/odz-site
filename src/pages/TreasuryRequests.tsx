import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Button, Chip, ConfirmAction, Field, Panel, Select, Textarea } from '../components'
import { supabase } from '../lib/supabase'
import { formatCents, parseAmount, treasuryMessage, type Fund } from '../lib/treasury'
import { actionsFor, checkAmount, STAGE_LABEL, stageOf, type TreasuryRequest } from '../lib/treasuryRequests'
import { useLoad } from '../lib/useLoad'

const COLUMNS =
  'id,requester,requester_callsign,amount_cents,note,status,needs_approval,threshold_at_submit,approved_by,approved_callsign,decided_callsign,decision_note,paid_date,paid_reference,created_at'

async function load() {
  const [reqs, avail, thr, approve] = await Promise.all([
    supabase!.from('treasury_requests').select(COLUMNS).order('created_at', { ascending: false }).limit(200),
    supabase!.rpc('treasury_my_available'),
    supabase!.rpc('treasury_threshold'),
    supabase!.rpc('treasury_can_approve'),
  ])
  if (reqs.error) throw new Error('requests')
  return {
    requests: (reqs.data ?? []) as unknown as TreasuryRequest[],
    available: Number(avail.data ?? 0),
    threshold: Number(thr.data ?? 0),
    canApprove: approve.data === true,
  }
}

/**
 * Treasury requests (MVA-217): give to a coffers fund, ask for a stored balance back, and the
 * Treasurer's and Command's queue. The database enforces every rule; this shows what it allowed.
 */
export function TreasuryRequests({ funds, canManage, onChange }: { funds: Fund[]; canManage: boolean; onChange: () => void }) {
  const { session } = useAuth()
  const data = useLoad(load)
  const d = data.data
  if (data.loading) return null
  if (data.failed || !d) return <p role="alert">Could not load the requests.</p>
  const me = { id: session?.user.id ?? '', canManage, canApprove: d.canApprove }

  const refresh = () => {
    void data.reload()
    onChange()
  }
  const pendingCount = d.requests.filter((r) => r.status === 'pending').length

  return (
    <>
      <Panel title="Give to the coffers">
        <Donate funds={funds} available={d.available} onDone={refresh} />
      </Panel>
      <Panel title="Ask for your balance back">
        <Refund available={d.available} threshold={d.threshold} onDone={refresh} />
      </Panel>
      <Panel title="Requests" action={<Chip variant={pendingCount ? 'pending' : 'plain'}>{pendingCount} PENDING</Chip>}>
        {d.requests.length === 0 ? (
          <p className="odz-muted">No requests.</p>
        ) : (
          <ul className="odz-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {d.requests.map((r) => (
              <RequestItem key={r.id} r={r} me={me} onDone={refresh} />
            ))}
          </ul>
        )}
      </Panel>
      {d.canApprove && <Threshold threshold={d.threshold} onDone={refresh} />}
    </>
  )
}

function Donate({ funds, available, onDone }: { funds: Fund[]; available: number; onDone: () => void }) {
  const [fund, setFund] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError(null)
    setDone(false)
    if (!fund) return setError('Choose a fund.')
    const a = checkAmount(amount, available)
    if (!a.ok) return setError(a.message)
    setBusy(true)
    const { error: err } = await supabase!.rpc('treasury_donate', { p_fund: fund, p_amount_cents: a.cents, p_note: note })
    setBusy(false)
    if (err) return setError(treasuryMessage(err.message))
    setAmount('')
    setNote('')
    setDone(true)
    onDone()
  }

  return (
    <div className="odz-stack">
      <p>
        Available to give or request: <strong aria-label="Available balance">{formatCents(available)}</strong>
      </p>
      <p className="odz-muted">A gift moves your stored balance into the fund straight away. No approval is needed.</p>
      <Select label="Fund" value={fund} onChange={(e) => setFund(e.target.value)} options={[{ value: '', label: 'Choose' }, ...funds.map((f) => ({ value: f.id, label: f.name }))]} />
      <Field label="Gift amount (dollars)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <Textarea label="Gift note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <Button variant="accent" disabled={busy || available === 0} onClick={() => void submit()}>
        Give to fund
      </Button>
      {done && <p role="status">Thank you. Your gift is in the ledger.</p>}
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

function Refund({ available, threshold, onDone }: { available: number; threshold: number; onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const parsed = parseAmount(amount)

  async function submit() {
    setError(null)
    const a = checkAmount(amount, available)
    if (!a.ok) return setError(a.message)
    if (note.trim().length < 3) return setError('A note of 3 to 500 characters is required.')
    setBusy(true)
    const { error: err } = await supabase!.rpc('treasury_request_refund', { p_amount_cents: a.cents, p_note: note })
    setBusy(false)
    if (err) return setError(treasuryMessage(err.message))
    setAmount('')
    setNote('')
    onDone()
  }

  return (
    <div className="odz-stack">
      <p className="odz-muted">
        The amount is set aside for you while the request is pending. Requests above {formatCents(threshold)} need Command approval first.
        {parsed.ok && parsed.cents > threshold && ' This one will.'}
      </p>
      <Field label="Refund amount (dollars)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <Textarea label="Refund note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <Button variant="accent" disabled={busy || available === 0} onClick={() => void submit()}>
        Request refund
      </Button>
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

function RequestItem({ r, me, onDone }: { r: TreasuryRequest; me: { id: string; canManage: boolean; canApprove: boolean }; onDone: () => void }) {
  const can = actionsFor(r, me)
  const stage = stageOf(r)
  const [mode, setMode] = useState<'none' | 'pay' | 'reject'>('none')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setError(null)
    const { error: err } = await fn()
    if (err) return setError(treasuryMessage(err.message))
    setMode('none')
    onDone()
  }

  return (
    <li className="odz-panel" style={{ padding: '0.75rem' }}>
      <div className="odz-row" style={{ justifyContent: 'space-between' }}>
        <strong>
          {r.requester_callsign ?? 'Former member'}: {formatCents(r.amount_cents)}
        </strong>
        <Chip variant={r.status === 'pending' ? 'pending' : 'plain'}>{STAGE_LABEL[stage]}</Chip>
      </div>
      <p>{r.note}</p>
      {r.approved_callsign && <p className="odz-muted">Approved by {r.approved_callsign}.</p>}
      {r.status === 'paid' && (
        <p className="odz-muted">
          Paid {r.paid_date}
          {r.paid_reference ? `: ${r.paid_reference}` : ''}
        </p>
      )}
      {r.status === 'rejected' && <p className="odz-muted">Reason: {r.decision_note}</p>}
      {mode === 'none' && (
        <div className="odz-row">
          {can.cancel && (
            <ConfirmAction label="Cancel request" confirmLabel="Confirm cancel" onConfirm={() => run(() => supabase!.rpc('treasury_cancel_request', { p_request: r.id }))} />
          )}
          {can.approve && (
            <ConfirmAction label="Approve" variant="accent" confirmLabel="Confirm approval" onConfirm={() => run(() => supabase!.rpc('treasury_approve_request', { p_request: r.id }))} />
          )}
          {can.pay && (
            <Button small variant="accent" onClick={() => setMode('pay')}>
              Mark paid
            </Button>
          )}
          {can.reject && (
            <Button small variant="sec" onClick={() => setMode('reject')}>
              Reject
            </Button>
          )}
        </div>
      )}
      {mode === 'pay' && (
        <div className="odz-stack">
          <Field label="Payment date" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          <Field label="Payment reference" value={reference} maxLength={300} onChange={(e) => setReference(e.target.value)} hint="Where the money went, for the record." />
          <div className="odz-row">
            <Button small variant="accent" onClick={() => void run(() => supabase!.rpc('treasury_pay_request', { p_request: r.id, p_paid_date: date, p_reference: reference }))}>
              Confirm paid
            </Button>
            <Button small variant="ghost" onClick={() => setMode('none')}>
              Back
            </Button>
          </div>
        </div>
      )}
      {mode === 'reject' && (
        <div className="odz-stack">
          <Textarea label="Reason for rejecting" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div className="odz-row">
            <Button small variant="accent" onClick={() => void run(() => supabase!.rpc('treasury_reject_request', { p_request: r.id, p_reason: reason }))}>
              Confirm reject
            </Button>
            <Button small variant="ghost" onClick={() => setMode('none')}>
              Back
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </p>
      )}
    </li>
  )
}

function Threshold({ threshold, onDone }: { threshold: number; onDone: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    // Zero is allowed (every request then needs Command approval), so parse "0" separately.
    const t = text.trim().replace(/^\$/, '').replace(/,/g, '')
    const a = t === '0' || t === '0.00' ? { ok: true as const, cents: 0 } : parseAmount(text)
    if (!a.ok) return setError('Enter an amount like 100 or 100.50.')
    const { error: err } = await supabase!.rpc('set_treasury_approval_threshold', { p_cents: a.cents })
    if (err) return setError(treasuryMessage(err.message))
    setText('')
    onDone()
  }

  return (
    <Panel title="Approval limit">
      <div className="odz-stack">
        <p>
          Refund requests at or below <strong aria-label="Approval limit">{formatCents(threshold)}</strong> are handled by the Treasurer alone. Above it, Command approves first.
        </p>
        {threshold === 0 && (
          <p role="note" className="odz-muted">
            The limit is $0.00, so every refund needs Command approval.
          </p>
        )}
        <Field label="New limit (dollars)" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
        <Button variant="sec" disabled={!text.trim()} onClick={() => void save()}>
          Set limit
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
