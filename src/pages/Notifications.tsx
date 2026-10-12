import { Link, useNavigate } from 'react-router'
import { Button, Chip, Panel } from '../components'
import { KIND_LABEL, loadNotifications, markAllRead, markRead, type NotificationRow } from '../lib/notifications'
import { safeLink } from '../lib/pushPayload'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'

export default function Notifications() {
  const list = useLoad(() => loadNotifications(50))
  const navigate = useNavigate()
  const unread = (list.data ?? []).filter((n) => !n.read_at).length

  async function open(n: NotificationRow) {
    await markRead(n.id)
    navigate(safeLink(n.link))
  }

  return (
    <>
      <div className="odz-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 className="odz-title">Notifications</h1>
        <span className="odz-row">
          <Link to="/settings/notifications">Settings</Link>
          {unread > 0 && (
            <Button small variant="sec" onClick={async () => { await markAllRead(); await list.reload() }}>
              Mark all read
            </Button>
          )}
        </span>
      </div>
      <Panel title="Latest">
        {list.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : list.failed ? (
          <p role="alert">Could not load notifications.</p>
        ) : (list.data ?? []).length === 0 ? (
          <p className="odz-muted">Nothing yet. Event reminders and changes show up here.</p>
        ) : (
          (list.data ?? []).map((n) => (
            <article key={n.id} className="odz-post" style={n.read_at ? { opacity: 0.7 } : undefined}>
              <div className="odz-row">
                {!n.read_at && <Chip variant="accent">NEW</Chip>}
                <Chip variant={n.kind === 'cancelled' ? 'alert' : 'plain'}>{KIND_LABEL[n.kind]}</Chip>
                <span className="odz-label">{formatStampPhoenix(n.created_at)}</span>
              </div>
              <h3 className="odz-post__title">{n.title}</h3>
              <p>{n.body}</p>
              <div style={{ marginTop: '0.5rem' }}>
                <Button small variant="sec" onClick={() => void open(n)}>
                  Open
                </Button>
              </div>
            </article>
          ))
        )}
      </Panel>
    </>
  )
}
