import { useEffect, useState, type FormEvent } from 'react'
import { Button, Field, Panel } from '../../components'
import { adminMessage } from '../../lib/admin'
import { validateCaps } from '../../lib/seats'
import { supabase } from '../../lib/supabase'
import { useLoad } from '../../lib/useLoad'

/**
 * Admin only. Changes the seat caps for future moves; nobody is demoted by lowering a cap. The
 * database logs who changed what and refuses anyone who is not an Admin.
 */
export default function SeatCaps() {
  const caps = useLoad(async () => {
    const { data, error } = await supabase!.from('seat_caps').select('old_guard_max,command_max').single()
    if (error) throw error
    return data as { old_guard_max: number; command_max: number }
  })
  const [og, setOg] = useState('')
  const [cm, setCm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (caps.data) {
      setOg(String(caps.data.old_guard_max))
      setCm(String(caps.data.command_max))
    }
  }, [caps.data])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setSaved(false)
    const bad = validateCaps(Number(og), Number(cm))
    if (bad) return setError(bad)
    setError(null)
    const { error: err } = await supabase.rpc('set_seat_caps', { p_old_guard_max: Number(og), p_command_max: Number(cm) })
    if (err) return setError(adminMessage(err))
    setSaved(true)
    void caps.reload()
  }

  return (
    <Panel title="Seat caps">
      {caps.failed ? (
        <p role="alert">Could not load the seat caps.</p>
      ) : (
        <form onSubmit={save} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <p className="odz-muted">
            Old Guard counts Command inside it. A change applies to future moves only; nobody is demoted by it. It is logged.
          </p>
          <Field label="Old Guard cap (Command included)" inputMode="numeric" disabled={!caps.data} value={og} onChange={(e) => setOg(e.target.value)} />
          <Field label="Command cap" inputMode="numeric" disabled={!caps.data} value={cm} onChange={(e) => setCm(e.target.value)} />
          {error && (
            <p role="alert" style={{ color: 'var(--alert)' }}>
              {error}
            </p>
          )}
          {saved && <p role="status">Saved.</p>}
          <Button type="submit" disabled={!caps.data}>
            Save caps
          </Button>
        </form>
      )}
    </Panel>
  )
}
