import { useEffect, useState } from 'react'
import { Link } from 'react-router'
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
    <Link to="/notifications" className="odz-label" aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}>
      ALERTS{count > 0 ? ` ${count > 99 ? '99+' : count}` : ''}
    </Link>
  )
}
