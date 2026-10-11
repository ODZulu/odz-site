import { NavLink, Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { sectionLabels, visibleSections, type Section } from '../../lib/admin'

/**
 * /admin: one area, sections by access. Not linked from public pages and hidden from accounts
 * with no access (they are sent to HQ). The database decides what each call may do.
 */
export default function AdminLayout() {
  const { capabilities, isAdmin } = useAuth()
  const location = useLocation()
  const sections = visibleSections(capabilities, isAdmin)
  if (sections.length === 0) return <Navigate to="/hq" replace />

  const current = location.pathname.split('/')[2] as Section | undefined
  if (!current) return <Navigate to={`/admin/${sections[0]}`} replace />
  if (!sections.includes(current)) return <Navigate to={`/admin/${sections[0]}`} replace />

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Admin
      </h1>
      <nav className="odz-subnav" aria-label="Admin sections">
        {sections.map((s) => (
          <NavLink key={s} to={`/admin/${s}`}>
            {sectionLabels[s]}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  )
}
