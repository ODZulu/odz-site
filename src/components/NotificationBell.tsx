import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Bell } from 'lucide-react'
import { unreadCount } from '../lib/notifications'

/** Bell with the unread count. Refreshes every minute and when the app comes back to the foreground. */
export function NotificationBell() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let alive = true
    const refresh = () => {
      unreadCount().then(
        (n) => alive && setCount(n),
        () => {},
      )
    }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return (
    <Link to="/notifications" className="odz-iconbtn" aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}>
      <Bell size={20} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      {count > 0 && (
        <span className="odz-badge" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  )
}
