import type { ReactNode } from 'react'
import { Link } from 'react-router'
import subdued from '../assets/logos/odz-logo-subdued.png'
import { buttonClass } from './Button'

/** Frame for pages that anyone can open (the public calendar). No nav, a sign-in link only. */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="odz">
      <header className="odz-bar">
        <Link to="/" className="odz-brand" aria-label="ODZ home">
          <img src={subdued} alt="" width={30} height={30} />
          <span>
            ODZ <span className="odz-muted">//</span> HQ
          </span>
        </Link>
        <Link to="/login" className={buttonClass('ghost', true)}>
          Sign in
        </Link>
      </header>
      <main className="odz-page">{children}</main>
    </div>
  )
}
