import { Navigate, Outlet } from 'react-router'
import { redirectFor, redirectIfSignedIn, type Page } from '../lib/access'
import { useAuth } from './AuthProvider'

function Checking() {
  return (
    <p className="odz-label" role="status">
      Checking access
    </p>
  )
}

/**
 * Route guard. Renders its child routes only when this account belongs on `page`; otherwise sends
 * it where it does belong. Navigation convenience only: RLS is the control.
 */
export function Gate({ page }: { page: Page }) {
  const { access } = useAuth()
  if (access.loading) return <Checking />
  const to = redirectFor(access, page)
  return to ? <Navigate to={to} replace /> : <Outlet />
}

/** For login and join: signed-in accounts are moved on to where they belong. */
export function PublicOnly({ children }: { children: React.ReactNode }) {
  const { access } = useAuth()
  if (access.loading) return <Checking />
  const to = redirectIfSignedIn(access)
  return to ? <Navigate to={to} replace /> : <>{children}</>
}
