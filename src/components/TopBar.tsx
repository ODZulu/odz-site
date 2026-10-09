import { Link } from 'react-router'
import subdued from '../assets/logos/odz-logo-subdued.png'
import { formatStamp } from '../lib/format'
import { TierMark } from './TierMark'

// Placeholder identity until auth lands (MVA-199). Obviously fake; the repo is public.
const PLACEHOLDER = { callsign: 'SAMPLE-1', tier: 'Member' }

export function TopBar({ now = new Date() }: { now?: Date }) {
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
        <span className="odz-label">{PLACEHOLDER.callsign}</span>
        <span className="odz-desktop-only">
          <TierMark tier={PLACEHOLDER.tier} />
        </span>
      </span>
    </header>
  )
}
