import { Link, Outlet } from 'react-router'
import subdued from '../assets/logos/odz-logo-subdued.png'

/** Frame for the pages before the app proper: login, join, account setup, pending, denied. No nav. */
export function GateLayout() {
  return (
    <div className="odz">
      <header className="odz-bar">
        <Link to="/" className="odz-brand" aria-label="ODZ home">
          <img src={subdued} alt="" width={30} height={30} />
          <span>
            ODZ <span className="odz-muted">//</span> HQ
          </span>
        </Link>
      </header>
      <main className="odz-page odz-gate">
        <Outlet />
      </main>
    </div>
  )
}
