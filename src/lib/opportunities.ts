/**
 * Event opportunities and member bids (MVA-230). The database decides (RLS and the RPCs in
 * 20261106120000_event_opportunities.sql); these helpers validate the form, shape the list and turn
 * the database's fixed error codes into words. Interest is advisory: it never commits the team.
 */
import { formatCents } from './treasury'

export type OpportunityStatus = 'open' | 'promoted' | 'dropped' | 'expired'
export type Response = 'In' | 'Maybe' | 'Out'
export const RESPONSES: readonly Response[] = ['In', 'Maybe', 'Out']

/** One row of opportunity_list(): the opportunity, counts by answer, and the caller's own answer. */
export type Opportunity = {
  id: string
  title: string
  host: string | null
  source_url: string | null
  starts_on: string
  ends_on: string | null
  location_text: string | null
  latitude: number | null
  longitude: number | null
  est_cost_cents: number | null
  notes: string | null
  status: OpportunityStatus
  created_by: string | null
  creator_callsign: string | null
  event_id: string | null
  drop_reason: string | null
  in_count: number
  maybe_count: number
  out_count: number
  my_response: Response | null
}

export type Responder = { profile_id: string; callsign: string | null; response: Response }

export type OpportunityForm = {
  title: string
  host: string
  source_url: string
  starts_on: string
  ends_on: string
  location_text: string
  /** Dollars, e.g. "45" or "45.50". Empty means unknown. */
  cost: string
  notes: string
}

export const emptyOpportunityForm: OpportunityForm = {
  title: '',
  host: '',
  source_url: '',
  starts_on: '',
  ends_on: '',
  location_text: '',
  cost: '',
  notes: '',
}

export type OpportunityErrors = Partial<Record<keyof OpportunityForm, string>>

const DATE = /^\d{4}-\d{2}-\d{2}$/
const URL_OK = /^https?:\/\/\S+$/i

const isRealDate = (v: string): boolean => {
  if (!DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}

/** "", "45", "45.5", "$1,200.00" -> cents (or null for empty). Zero is allowed (a free event). */
export function parseCost(text: string): { ok: true; cents: number | null } | { ok: false } {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (t === '') return { ok: true, cents: null }
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return { ok: false }
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return cents <= 100_000_000 ? { ok: true, cents } : { ok: false }
}

export function validateOpportunity(f: OpportunityForm): OpportunityErrors {
  const e: OpportunityErrors = {}
  if (f.title.trim() === '') e.title = 'Title is required.'
  else if (f.title.trim().length > 120) e.title = 'Title is too long (120 characters).'
  if (f.host.length > 120) e.host = 'Too long (120 characters).'
  if (f.source_url.trim() !== '' && (f.source_url.trim().length > 500 || !URL_OK.test(f.source_url.trim()))) {
    e.source_url = 'Enter a web address starting with http:// or https://.'
  }
  if (!isRealDate(f.starts_on)) e.starts_on = 'Enter a start date.'
  if (f.ends_on !== '') {
    if (!isRealDate(f.ends_on)) e.ends_on = 'Enter a valid end date.'
    else if (isRealDate(f.starts_on) && f.ends_on < f.starts_on) e.ends_on = 'The end must not be before the start.'
  }
  if (f.location_text.length > 200) e.location_text = 'Too long (200 characters).'
  if (!parseCost(f.cost).ok) e.cost = 'Enter dollars, like 45 or 45.50.'
  if (f.notes.length > 2000) e.notes = 'Too long (2000 characters).'
  return e
}

export const hasOpportunityErrors = (e: OpportunityErrors): boolean => Object.keys(e).length > 0

/** The arguments of the opportunity_save() RPC. Call only after validateOpportunity() is clean. */
export function toSaveArgs(id: string | null, f: OpportunityForm) {
  const cost = parseCost(f.cost)
  return {
    p_id: id,
    p_title: f.title.trim(),
    p_host: f.host.trim() || null,
    p_source_url: f.source_url.trim() || null,
    p_starts_on: f.starts_on,
    p_ends_on: f.ends_on || null,
    p_location_text: f.location_text.trim() || null,
    p_latitude: null,
    p_longitude: null,
    p_est_cost_cents: cost.ok ? cost.cents : null,
    p_notes: f.notes.trim() || null,
  }
}

export function toForm(o: Opportunity): OpportunityForm {
  return {
    title: o.title,
    host: o.host ?? '',
    source_url: o.source_url ?? '',
    starts_on: o.starts_on,
    ends_on: o.ends_on ?? '',
    location_text: o.location_text ?? '',
    cost: o.est_cost_cents === null ? '' : (o.est_cost_cents / 100).toFixed(2),
    notes: o.notes ?? '',
  }
}

export const costLabel = (cents: number | null): string =>
  cents === null ? 'Not given' : cents === 0 ? 'Free' : `${formatCents(cents)} per person`

export const STATUS_LABEL: Record<OpportunityStatus, string> = {
  open: 'Open',
  promoted: 'Promoted',
  dropped: 'Dropped',
  expired: 'Expired',
}

export type StatusFilter = OpportunityStatus | 'all'

/** Filters by status and, optionally, to the ones the caller answered In; sorted by start date. */
export function filterOpportunities(rows: readonly Opportunity[], status: StatusFilter, onlyIn: boolean): Opportunity[] {
  return rows
    .filter((o) => (status === 'all' || o.status === status) && (!onlyIn || o.my_response === 'In'))
    .sort((a, b) => (a.starts_on === b.starts_on ? 0 : a.starts_on < b.starts_on ? -1 : 1))
}

export const countsLine = (o: Pick<Opportunity, 'in_count' | 'maybe_count' | 'out_count'>): string =>
  `${o.in_count} In, ${o.maybe_count} Maybe, ${o.out_count} Out`

export const DROP_REASON_MIN = 3

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  not_found: 'That opportunity is not available.',
  not_open: 'This opportunity is no longer open.',
  invalid_response: 'Choose In, Maybe or Out.',
  invalid_reason: `Give a reason (${DROP_REASON_MIN} to 500 characters).`,
  invalid_event_type: 'Choose an event type.',
}

/** Maps the database's fixed error codes to words. Never echoes anything the user typed. */
export function opportunityMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Check the form and try again.'
}
