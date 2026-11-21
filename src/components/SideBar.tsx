import { Link } from 'react-router'
import subdued from '../assets/logos/odz-logo-subdued.png'
import { useAuth } from '../auth/AuthProvider'
import { Button, buttonClass } from './Button'
import { TierMark } from './TierMark'

/** Brand block at the top of the desktop sidebar. */
export function SideBrand() {
  return (
    <Link to="/" className="odz-brand odz-side__brand" aria-label="ODZ home">
      <img src={subdued} alt="" width={30} height={30} />
      <span>
        ODZ <span className="odz-muted">//</span> HQ
      </span>
    </Link>
  )
}

/** Bottom of the desktop sidebar: who is signed in, their tier, and the existing profile and sign-out actions. */
export function UserCard() {
  const { profile, tierName, signOut } = useAuth()
  return (
    <div className="odz-side__user">
      {profile?.callsign &&
        (profile.status === 'retired' ? (
          <span className="odz-heading">{profile.callsign}</span>
        ) : (
          <Link to="/me" className={buttonClass('sec', true)} aria-label="My profile">
            {profile.callsign}
          </Link>
        ))}
      {tierName && <TierMark tier={tierName} />}
      <Button variant="ghost" small onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  )
}
