import { Chip } from './Chip'

/** Duty-role badges (MVA-220) shown on the roster and on a profile. Empty when none are held. */
export function DesignationBadges({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null
  return (
    <span className="odz-row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
      {names.map((name) => (
        <Chip key={name} variant="accent">
          {name}
        </Chip>
      ))}
    </span>
  )
}
