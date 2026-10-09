const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const pad = (n: number) => String(n).padStart(2, '0')

/** Status-bar stamp in the team style: 24-hour local time, e.g. "30 SEP 2026 · 0630L". */
export function formatStamp(d: Date): string {
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${pad(d.getHours())}${pad(d.getMinutes())}L`
}
