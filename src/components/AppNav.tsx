import { NavLink } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { visibleSections } from '../lib/admin'
import { navItems } from '../nav'

/** Top nav strip on desktop; fixed bottom tab bar below 720px (CSS only). */
export function AppNav() {
  const { capabilities, isAdmin } = useAuth()
  const showAdmin = visibleSections(capabilities, isAdmin).length > 0
  return (
    <nav className="odz-nav" aria-label="Main">
      {navItems.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {item.label}
        </NavLink>
      ))}
      {showAdmin && <NavLink to="/admin">ADMIN</NavLink>}
    </nav>
  )
}
