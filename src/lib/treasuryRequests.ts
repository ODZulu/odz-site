/**
 * Treasury requests (MVA-217): donate to a coffers fund, or ask for a stored balance back. The
 * database decides (reservations, the approval threshold, who may approve); these helpers mirror
 * the rules so the screens can explain them, and are tested against the same cases as the SQL.
 */
import { parseAmount } from './treasury'

export type RequestStatus = 'pending' | 'paid' | 'rejected' | 'cancelled'

export type TreasuryRequest = {
  id: string
  requester: string
  requester_callsign: string | null
  amount_cents: number
  note: string
  status: RequestStatus
  needs_approval: boolean
  threshold_at_submit: number
  approved_by: string | null
  approved_callsign: string | null
  decided_callsign: string | null
  decision_note: string | null
  paid_date: string | null
  paid_reference: string | null
  created_at: string
}

/** What may still be given or requested: the stored balance minus cents reserved by pending requests. */
export const availableCents = (balance: number, reserved: number): number => Math.max(0, balance - reserved)

/** Cents reserved by this member's pending requests. */
export const reservedCents = (requests: readonly TreasuryRequest[], member: string): number =>
  requests.filter((r) => r.requester === member && r.status === 'pending').reduce((sum, r) => sum + r.amount_cents, 0)

/** At or below the threshold the Treasurer alone handles it; above it Command must approve first. */
export const needsApproval = (amount: number, threshold: number): boolean => amount > threshold

export type Stage = 'awaiting_approval' | 'ready_to_pay' | 'paid' | 'rejected' | 'cancelled'

export function stageOf(r: Pick<TreasuryRequest, 'status' | 'needs_approval' | 'approved_by'>): Stage {
  if (r.status !== 'pending') return r.status
  return r.needs_approval && !r.approved_by ? 'awaiting_approval' : 'ready_to_pay'
}

export const STAGE_LABEL: Record<Stage, string> = {
  awaiting_approval: 'AWAITING COMMAND APPROVAL',
  ready_to_pay: 'WITH THE TREASURER',
  paid: 'PAID',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
}

/** Who may do what to a request, mirroring the database (the database is the authority). */
export function actionsFor(
  r: TreasuryRequest,
  me: { id: string; canManage: boolean; canApprove: boolean },
): { cancel: boolean; approve: boolean; pay: boolean; reject: boolean } {
  const pending = r.status === 'pending'
  const own = r.requester === me.id
  const stage = stageOf(r)
  return {
    cancel: pending && own,
    approve: pending && !own && me.canApprove && stage === 'awaiting_approval',
    pay: pending && !own && me.canManage && stage === 'ready_to_pay',
    reject: pending && !own && (me.canManage || me.canApprove),
  }
}

/** Checks an amount box against what is available. */
export function checkAmount(text: string, available: number): { ok: true; cents: number } | { ok: false; message: string } {
  const a = parseAmount(text)
  if (!a.ok) return { ok: false, message: 'Enter an amount like 25 or 25.50.' }
  if (a.cents > available) return { ok: false, message: 'That is more than you have available.' }
  return { ok: true, cents: a.cents }
}
