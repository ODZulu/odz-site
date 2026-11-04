/**
 * Treasury ledger (MVA-216). Tracking only: the app never holds or moves money. The database is
 * the authority (append-only entries, derived balances, no negatives); these helpers format and
 * filter what it returned and mirror its rules so the screens can explain them.
 */

export type BucketKind = 'external' | 'member' | 'fund'

export type Entry = {
  id: string
  entry_date: string
  amount_cents: number
  from_kind: BucketKind
  from_member: string | null
  from_fund: string | null
  from_callsign: string | null
  to_kind: BucketKind
  to_member: string | null
  to_fund: string | null
  to_callsign: string | null
  category: string
  note: string
  reverses: string | null
  entered_by_callsign: string | null
  created_at: string
}

export type Fund = { id: string; name: string }

export const CATEGORIES = ['deposit', 'withdrawal', 'transfer', 'donation', 'refund', 'event', 'equipment', 'dues', 'adjustment', 'other'] as const

export const BANNER = 'Tracking only. Real money is held by banks.'

/** 12345 -> "$123.45"; negatives keep the sign in front of the dollar sign. Integer cents only. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.floor(abs / 100)
  const rest = String(abs % 100).padStart(2, '0')
  return `${sign}$${dollars.toLocaleString('en-US')}.${rest}`
}

/**
 * "12", "12.5", "12.50", "$1,200.00" -> cents. Anything else (letters, three decimals, zero,
 * negative, over $1,000,000) is rejected, so no float ever touches money.
 */
export function parseAmount(text: string): { ok: true; cents: number } | { ok: false } {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '')
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return { ok: false }
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return cents >= 1 && cents <= 100_000_000 ? { ok: true, cents } : { ok: false }
}

export type Bucket = { kind: BucketKind; id: string | null }

const fromBucket = (e: Entry): Bucket => ({ kind: e.from_kind, id: e.from_member ?? e.from_fund })
const toBucket = (e: Entry): Bucket => ({ kind: e.to_kind, id: e.to_member ?? e.to_fund })

/** The signed effect of an entry on one bucket: + in, - out, 0 when it is not involved. */
export function effectOn(e: Entry, bucket: Bucket): number {
  const f = fromBucket(e)
  const t = toBucket(e)
  let n = 0
  if (t.kind === bucket.kind && t.id === bucket.id) n += e.amount_cents
  if (f.kind === bucket.kind && f.id === bucket.id) n -= e.amount_cents
  return n
}

/** A balance derived from entries, exactly as the database derives it. */
export const balanceOf = (entries: readonly Entry[], bucket: Bucket): number =>
  entries.reduce((sum, e) => sum + effectOn(e, bucket), 0)

/** External in minus external out, and the sum over every member and fund bucket. They must match. */
export function reconcile(entries: readonly Entry[]): { net: number; buckets: number; ok: boolean } {
  let net = 0
  let buckets = 0
  for (const e of entries) {
    if (e.from_kind === 'external') net += e.amount_cents
    if (e.to_kind === 'external') net -= e.amount_cents
    if (e.to_kind !== 'external') buckets += e.amount_cents
    if (e.from_kind !== 'external') buckets -= e.amount_cents
  }
  return { net, buckets, ok: net === buckets }
}

export type LedgerFilter = { from: string; to: string; bucket: string; category: string }
export const NO_FILTER: LedgerFilter = { from: '', to: '', bucket: '', category: '' }

/** bucket is "" (any), "member:<id>" or "fund:<id>". Dates are inclusive YYYY-MM-DD. */
export function filterEntries(entries: readonly Entry[], f: LedgerFilter): Entry[] {
  return entries.filter((e) => {
    if (f.from && e.entry_date < f.from) return false
    if (f.to && e.entry_date > f.to) return false
    if (f.category && e.category !== f.category) return false
    if (f.bucket) {
      const [kind, id] = f.bucket.split(':')
      if (effectOn(e, { kind: kind as BucketKind, id }) === 0) return false
    }
    return true
  })
}

/** Where the money came from or went, in words. */
export function bucketLabel(kind: BucketKind, callsign: string | null, fundId: string | null, funds: readonly Fund[]): string {
  if (kind === 'external') return 'Outside'
  if (kind === 'fund') return funds.find((x) => x.id === fundId)?.name ?? 'Fund'
  return callsign ?? 'Former member'
}

/** Stops a spreadsheet reading a cell as a formula (CSV injection). */
function cell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export const CSV_HEADER = ['date', 'amount', 'from', 'to', 'category', 'note', 'reverses', 'entered_by', 'created_at']

/** The filtered ledger as CSV text. Amounts are plain dollars.cents numbers. */
export function toCsv(entries: readonly Entry[], funds: readonly Fund[]): string {
  const rows = entries.map((e) => [
    e.entry_date,
    `${Math.floor(e.amount_cents / 100)}.${String(e.amount_cents % 100).padStart(2, '0')}`,
    bucketLabel(e.from_kind, e.from_callsign, e.from_fund, funds),
    bucketLabel(e.to_kind, e.to_callsign, e.to_fund, funds),
    e.category,
    e.note,
    e.reverses ?? '',
    e.entered_by_callsign ?? '',
    e.created_at,
  ])
  return [CSV_HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  not_found: 'That record is not available.',
  bad_name: 'A name of 2 to 60 characters is required.',
  name_taken: 'A fund with that name already exists.',
  bad_date: 'Choose a valid date, not in the future.',
  bad_amount: 'Enter an amount greater than zero.',
  bad_bucket: 'Choose where the money comes from and goes to.',
  bad_category: 'Choose a category.',
  bad_note: 'A note of 3 to 500 characters is required.',
  insufficient_funds: 'That would take a balance below zero, so it was refused.',
  already_reversed: 'That entry has already been reversed.',
  is_reversal: 'A reversal cannot be reversed. Enter a new correcting entry.',
  not_pending: 'That request is no longer pending.',
  own_request: 'You cannot decide your own request.',
  needs_approval: 'This request is above the limit and needs Command approval first.',
  no_approval_needed: 'This request is at or below the limit and needs no approval.',
  already_approved: 'That request is already approved.',
}

/** Maps the database's fixed error codes to words. Never echoes anything the user typed. */
export function treasuryMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Try again.'
}
