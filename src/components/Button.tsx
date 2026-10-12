import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'sec' | 'ghost' | 'accent'

const variantClass: Record<ButtonVariant, string | null> = {
  primary: null,
  sec: 'odz-btn--sec',
  ghost: 'odz-btn--ghost',
  accent: 'odz-btn--accent',
}

export function buttonClass(variant: ButtonVariant = 'primary', small = false, block = false): string {
  return cx('odz-btn', variantClass[variant], small && 'odz-btn--sm', block && 'odz-btn--block-mobile')
}

type Shared = { variant?: ButtonVariant; small?: boolean; block?: boolean; children: ReactNode }

/** One `accent` button per screen at most. */
export function Button({
  variant,
  small,
  block,
  className,
  ...rest
}: Shared & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={cx(buttonClass(variant, small, block), className)} />
}

export function ButtonLink({ variant, small, block, className, ...rest }: Shared & LinkProps) {
  return <Link {...rest} className={cx(buttonClass(variant, small, block), className)} />
}
