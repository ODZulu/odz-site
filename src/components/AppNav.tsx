import { NavLink } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { visibleSections } from '../lib/admin'
import { navItems } from '../nav'

/** Top nav strip on desktop; fixed bottom tab bar below 720px (CSS only). */
export function AppNav() {
  const { capabilities, isAdmin, can, tierName, profile } = useAuth()
  if (profile?.status === 'retired') {
    // Retired accounts (MVA-238) reach only their own home and Traffic; the database denies the rest anyway.
    return (
      <nav className="odz-nav" aria-label="Main">
        <NavLink to="/retired">HOME</NavLink>
        <NavLink to="/traffic">TRAFFIC</NavLink>
      </nav>
    )
  }
  const showAdmin = visibleSections(capabilities, isAdmin).length > 0
  // The designations page is open to Old Guard and Command even with no capability of their own
  // (same three-way check as the database); this is a convenience hide, not the access control.
  const showDesignations = isAdmin || can('edit_roster') || tierName === 'Old Guard' || tierName === 'Command'
  return (
    <nav className="odz-nav" aria-label="Main">
      {navItems.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {item.label}
        </NavLink>
      ))}
      {showDesignations && <NavLink to="/designations">DESIGNATIONS</NavLink>}
      {(can("read_minutes") || can("write_minutes")) && <NavLink to="/minutes">MINUTES</NavLink>}
      {(can("read_documents") || can("publish_documents")) && <NavLink to="/documents">DOCS</NavLink>}
      {showAdmin && <NavLink to="/admin">ADMIN</NavLink>}
    </nav>
  )
}
