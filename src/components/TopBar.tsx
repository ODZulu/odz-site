import { UserRound } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import subdued from '../assets/logos/odz-logo-subdued.png'
import { useAuth } from '../auth/AuthProvider'
import { formatStamp } from '../lib/format'
import { crumbs } from '../nav'
import { Button, buttonClass } from './Button'
import { NotificationBell } from './NotificationBell'

/**
 * Desktop: breadcrumb, date stamp, notification bell, small profile button (the sidebar holds the
 * brand, tier and sign out). Mobile: brand, callsign, bell and sign out, as before.
 */
export function TopBar({ now = new Date(), mobile = false }: { now?: Date; mobile?: boolean }) {
  const { profile, signOut } = useAuth()
  const retired = profile?.status === 'retired'
  const trail = crumbs(useLocation().pathname)

  if (mobile) {
    return (
      <header className="odz-bar">
        <Link to="/" className="odz-brand" aria-label="ODZ home">
          <img src={subdued} alt="" width={30} height={30} />
          <span>
            ODZ <span className="odz-muted">//</span> HQ
          </span>
        </Link>
        <span className="odz-row">
          {profile?.callsign &&
            (retired ? (
              <span className="odz-label">{profile.callsign}</span>
            ) : (
              <Link to="/me" className={buttonClass('sec', true)} aria-label="My profile">
                {profile.callsign}
              </Link>
            ))}
          <NotificationBell />
          <Button variant="ghost" small onClick={() => void signOut()}>
            Sign out
          </Button>
        </span>
      </header>
    )
  }

  return (
    <header className="odz-bar odz-bar--desk">
      <nav aria-label="Breadcrumb" className="odz-crumbs">
        <ol>
          {trail.map((c, i) => (
            <li key={c} aria-current={i === trail.length - 1 ? 'page' : undefined}>
              {i > 0 && (
                <span className="odz-sep" aria-hidden="true">
                  /
                </span>
              )}
              {c}
            </li>
          ))}
        </ol>
      </nav>
      <span className="odz-row">
        <span className="odz-label">{formatStamp(now)}</span>
        <NotificationBell />
        {!retired && (
          <Link to="/me" className="odz-iconbtn" aria-label="Profile">
            <UserRound size={20} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </Link>
        )}
      </span>
    </header>
  )
}
