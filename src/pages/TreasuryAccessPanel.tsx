import { useState } from 'react'
import { Button, Chip, ConfirmAction, Panel } from '../components'
import { treasuryMessage } from '../lib/treasury'
import { supabase } from '../lib/supabase'

/**
 * Admin switch for Treasury member access (MVA-255). Only rendered when the database returned a
 * value for the Admin-only read, so a non-Admin never sees it. The RPC does the real check and
 * writes the settings audit row.
 */
export function TreasuryAccessPanel({ on, onDone }: { on: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null)

  async function set(next: boolean) {
    setError(null)
    const { error: err } = await supabase!.rpc('set_treasury_member_access', { p_on: next })
    if (err) return setError(treasuryMessage(err.message))
    onDone()
  }

  return (
    <Panel title="Member access" action={<Chip variant={on ? 'accent' : 'pending'}>{on ? 'ON' : 'OFF'}</Chip>}>
      <div className="odz-stack">
        <p aria-label="Member access state">
          {on
            ? 'Members can see their own entries and balance, give to coffers and request refunds. Old Guard and Command see the full ledger.'
            : 'Only Admins can use the treasury. Members see "The treasury is not open yet."'}
        </p>
        {on ? (
          <>
            <p className="odz-muted">
              Turning it off closes the treasury to everyone except Admins: members lose their balance, their requests and the ability to give or request refunds. Nothing is deleted.
            </p>
            <ConfirmAction label="Turn member access off" confirmLabel="Confirm: turn off" small={false} onConfirm={() => set(false)} />
          </>
        ) : (
          <Button variant="accent" onClick={() => void set(true)}>
            Turn member access on
          </Button>
        )}
        {error && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {error}
          </p>
        )}
      </div>
    </Panel>
  )
}
