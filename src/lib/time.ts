/**
 * Team time (MVA-201): events are stored in UTC and shown in America/Phoenix, which has no
 * daylight saving (always UTC-7), in 24-hour form like `0630L`.
 */

export const TZ = 'America/Phoenix'
export const TZ_LABEL = 'All times Phoenix (MST, no daylight saving), 24-hour.'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
})

type Parts = { year: string; month: string; day: string; hour: string; minute: string; weekday: string }

function parts(input: string | Date): Parts {
  const d = typeof input === 'string' ? new Date(input) : input
  const out: Record<string, string> = {}
  for (const p of formatter.formatToParts(d)) out[p.type] = p.value
  return out as unknown as Parts
}

/** `0630L` */
export function formatTimeL(input: string | Date): string {
  const p = parts(input)
  return `${p.hour}${p.minute}L`
}

/** `SAT 10 OCT 2026` */
export function formatDateLine(input: string | Date): string {
  const p = parts(input)
  return `${p.weekday.toUpperCase()} ${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`
}

/** `10OCT26 0630L` */
export function formatStampPhoenix(input: string | Date): string {
  const p = parts(input)
  return `${p.day}${MONTHS[Number(p.month) - 1]}${p.year.slice(2)} ${p.hour}${p.minute}L`
}

/** Phoenix calendar day, `2026-10-10`. Used to group an agenda. */
export function dayKey(input: string | Date): string {
  const p = parts(input)
  return `${p.year}-${p.month}-${p.day}`
}

/** For a `datetime-local` input: the Phoenix wall-clock time of an instant. */
export function toLocalInput(input: string | Date): string {
  const p = parts(input)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** From a `datetime-local` value read as Phoenix wall-clock time to a UTC ISO string. Null if invalid. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const d = new Date(`${value}:00-07:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** A calendar date with no time (`2026-10-10`) as `10 OCT 2026`. No timezone shift: it is a date, not an instant. */
export function formatPlainDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return value
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}
