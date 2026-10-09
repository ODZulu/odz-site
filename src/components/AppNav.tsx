import { NavLink } from 'react-router'
import { navItems } from '../nav'

/** Top nav strip on desktop; fixed bottom tab bar below 720px (CSS only). */
export function AppNav() {
  return (
    <nav className="odz-nav" aria-label="Main">
      {navItems.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
