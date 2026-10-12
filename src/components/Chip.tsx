import type { ReactNode } from 'react'
import { cx } from './cx'

export type ChipVariant = 'go' | 'pending' | 'alert' | 'accent' | 'plain'

// Status is never colour alone: the status variants fall back to a word when none is given.
const defaultWord: Partial<Record<ChipVariant, string>> = {
  go: 'GO',
  pending: 'PENDING',
  alert: 'NO-GO',
}

type ChipProps = { variant?: ChipVariant; children?: ReactNode }

export function Chip({ variant = 'plain', children }: ChipProps) {
  const word = children === undefined || children === null || children === '' ? defaultWord[variant] : children
  return <span className={cx('odz-chip', `odz-chip--${variant}`)}>{word}</span>
}
