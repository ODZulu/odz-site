import { useId, type InputHTMLAttributes } from 'react'
import { Input } from './Input'

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  /** Help text under the input. */
  hint?: string
  error?: string
}

/** Visible label, input, optional hint and error. Errors never repeat the value that was typed. */
export function Field({ label, hint, error, id, ...rest }: FieldProps) {
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
      <Input {...rest} id={inputId} label={label} aria-invalid={error ? true : undefined} aria-describedby={described} />
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
