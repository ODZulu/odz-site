import { useId, type TextareaHTMLAttributes } from 'react'
import { cx } from './cx'

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string
  hint?: string
  error?: string
}

/** Multi-line field with the same label, hint and error pattern as Field. */
export function Textarea({ label, hint, error, id, className, ...rest }: TextareaProps) {
  const auto = useId()
  const inputId = id ?? auto
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <label htmlFor={inputId} className="odz-label">
        {label}
      </label>
      <textarea
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={cx('odz-input', 'odz-textarea', className)}
      />
      {hint && (
        <span id={hintId} className="odz-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} role="alert" style={{ color: 'var(--alert)' }}>
          {error}
        </span>
      )}
    </div>
  )
}
