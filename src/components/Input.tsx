import type { InputHTMLAttributes } from 'react'
import { cx } from './cx'

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Visible or screen-reader label; every input needs one. */
  label: string
}

export function Input({ label, className, ...rest }: InputProps) {
  return <input aria-label={label} {...rest} className={cx('odz-input', className)} />
}
