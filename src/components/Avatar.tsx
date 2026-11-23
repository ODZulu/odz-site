import { cx } from './cx'

const TINTS = ['sage', 'sand', 'steel', 'clay'] as const

/** Up to two letters or digits from the name. */
export function initialsOf(name: string): string {
  const parts = name.toUpperCase().match(/[A-Z0-9]+/g) ?? []
  if (parts.length === 0) return '?'
  return parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]!.charAt(0) + parts[1]!.charAt(0)
}

/** The same name always gets the same tint. */
export function tintOf(name: string): (typeof TINTS)[number] {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TINTS[h % TINTS.length]
}

/** Initials avatar for a list row. Decoration: the name is always written beside it, so it is hidden from assistive tech. */
export function Avatar({ name }: { name: string }) {
  return (
    <span className={cx('odz-avatar', `odz-avatar--${tintOf(name)}`)} aria-hidden="true">
      {initialsOf(name)}
    </span>
  )
}
