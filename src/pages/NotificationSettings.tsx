import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Button, Chip, Panel } from '../components'
import {
  currentSupport,
  disablePush,
  enablePush,
  loadPrefs,
  savePrefs,
  sendTest,
  vapidPublicKey,
  type Prefs,
} from '../lib/notifications'
import { LEAD_PRESETS, normalizeLeads } from '../lib/pushPayload'
import { useLoad } from '../lib/useLoad'

/** /settings/notifications: push on or off, lead times, and a test button. iOS Safari gets a plain notice. */
export default function NotificationSettings() {
  const prefs = useLoad(loadPrefs)
  const support = currentSupport()
  const [leads, setLeads] = useState<number[]>([1440, 120])
  const [pushOn, setPushOn] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (prefs.data) {
      setLeads(prefs.data.lead_minutes)
      setPushOn(prefs.data.push_enabled)
    }
  }, [prefs.data])

  async function persist(next: Prefs) {
    try {
      await savePrefs(next)
      setMessage('Saved.')
    } catch {
      setMessage('Could not save.')
    }
    await prefs.reload()
  }

  async function togglePush(on: boolean) {
    setBusy(true)
    setMessage(null)
    if (on) {
      const res = await enablePush()
      if (!res.ok) {
        setMessage(res.reason)
        setBusy(false)
        return
      }
      await persist({ push_enabled: true, lead_minutes: normalizeLeads(leads) ?? [1440, 120] })
    } else {
      await disablePush()
      await persist({ push_enabled: false, lead_minutes: normalizeLeads(leads) ?? [1440, 120] })
    }
    setBusy(false)
  }

  async function toggleLead(minutes: number, on: boolean) {
    const next = on ? [...leads, minutes] : leads.filter((m) => m !== minutes)
    const normalized = normalizeLeads(next)
    if (!normalized) {
      setMessage('Keep at least one reminder time.')
      return
    }
    setLeads(normalized)
    await persist({ push_enabled: pushOn, lead_minutes: normalized })
  }

  async function test() {
    setMessage(null)
    const r = await sendTest()
    setMessage(
      r === 'ok'
        ? pushOn
          ? 'Test sent. It appears here now and arrives as a push within a minute.'
          : 'Test sent. It appears under Notifications. Turn push on to also get it as a notification.'
        : r === 'too_soon'
          ? 'Wait a minute between tests.'
          : 'Could not send the test.',
    )
  }

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/notifications">Notifications</Link>
      </p>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Notification settings
      </h1>
      <div className="odz-stack">
        <Panel title="Push" action={pushOn ? <Chip variant="go">ON</Chip> : <Chip variant="plain">OFF</Chip>}>
          {!support.supported ? (
            <p>{support.reason}</p>
          ) : !vapidPublicKey() ? (
            <p className="odz-muted">Push is not set up for this build yet. In-app notifications still work.</p>
          ) : (
            <>
              <p className="odz-muted" style={{ marginBottom: '0.75rem' }}>
                Get event reminders as a notification on this device. Only the event name and time are sent, never the location.
              </p>
              <label className="odz-check">
                <input type="checkbox" checked={pushOn} disabled={busy || prefs.loading} onChange={(e) => void togglePush(e.target.checked)} />
                <span>Push notifications on this device</span>
              </label>
            </>
          )}
        </Panel>

        <Panel title="Remind me">
          {LEAD_PRESETS.map((p) => (
            <label key={p.minutes} className="odz-check">
              <input type="checkbox" checked={leads.includes(p.minutes)} onChange={(e) => void toggleLead(p.minutes, e.target.checked)} />
              <span>{p.label}</span>
            </label>
          ))}
          <p className="odz-muted" style={{ marginTop: '0.5rem' }}>
            Reminders always appear under Notifications; push is in addition.
          </p>
        </Panel>

        <Panel title="Test">
          <Button variant="sec" onClick={() => void test()}>
            Send test notification
          </Button>
        </Panel>

        {message && <p role="status">{message}</p>}
      </div>
    </>
  )
}
