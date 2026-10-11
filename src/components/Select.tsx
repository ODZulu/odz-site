import { useId, type SelectHTMLAttributes } from 'react'
import { cx } from './cx'

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  /** Hide the visible label when the surrounding row already names the control. */
  hideLabel?: boolean
  options: Array<{ value: string; label: string }>
}

export function Select({ label, hideLabel, options, className, id, ...rest }: SelectProps) {
  const auto = useId()
  const selectId = id ?? auto
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <label htmlFor={selectId} className={hideLabel ? 'odz-sr' : 'odz-label'}>
        {label}
      </label>
      <select id={selectId} {...rest} className={cx('odz-input', className)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
