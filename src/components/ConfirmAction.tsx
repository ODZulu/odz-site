import { useState } from 'react'
import { Button, type ButtonVariant } from './Button'

type Props = {
  label: string
  confirmLabel?: string
  variant?: ButtonVariant
  small?: boolean
  disabled?: boolean
  onConfirm: () => void | Promise<void>
}

/** Two-step button: the first press asks, the second does it. No browser dialogs. */
export function ConfirmAction({ label, confirmLabel, variant = 'sec', small = true, disabled, onConfirm }: Props) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button variant={variant} small={small} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    )
  }
  return (
    <span className="odz-row" role="group" aria-label={`Confirm ${label}`}>
      <Button
        variant="accent"
        small={small}
        onClick={async () => {
          setAsking(false)
          await onConfirm()
        }}
      >
        {confirmLabel ?? `Confirm ${label.toLowerCase()}`}
      </Button>
      <Button variant="ghost" small={small} onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  )
}
