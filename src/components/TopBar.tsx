import { Link } from 'react-router'
import subdued from '../assets/logos/odz-logo-subdued.png'
import { useAuth } from '../auth/AuthProvider'
import { formatStamp } from '../lib/format'
import { Button } from './Button'
import { TierMark } from './TierMark'

export function TopBar({ now = new Date() }: { now?: Date }) {
  const { profile, tierName, signOut } = useAuth()
  return (
    <header className="odz-bar">
      <Link to="/" className="odz-brand" aria-label="ODZ home">
        <img src={subdued} alt="" width={30} height={30} />
        <span>
          ODZ <span className="odz-muted">//</span> HQ
        </span>
      </Link>
      <span className="odz-label odz-desktop-only">{formatStamp(now)}</span>
      <span className="odz-row">
        {profile?.callsign && (
          <Link to="/me" className="odz-label" aria-label="My profile">
            {profile.callsign}
          </Link>
        )}
        {tierName && (
          <span className="odz-desktop-only">
            <TierMark tier={tierName} />
          </span>
        )}
        <Button variant="ghost" small onClick={() => void signOut()}>
          Sign out
        </Button>
      </span>
    </header>
  )
}
