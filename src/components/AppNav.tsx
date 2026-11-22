import { useEffect, useState } from 'react'
import { NavLink } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { visibleSections } from '../lib/admin'
import { supabase } from '../lib/supabase'
import { BadgeCheck, CalendarDays, FileText, Gavel, House, Landmark, LayoutDashboard, NotebookText, Radio, Settings, Target, Users, type LucideIcon } from 'lucide-react'
import { navItems } from '../nav'

const ICONS: Record<string, LucideIcon> = {
  '/hq': LayoutDashboard,
  '/roster': Users,
  '/calendar': CalendarDays,
  '/designations': BadgeCheck,
  '/motions': Gavel,
  '/opportunities': Target,
  '/minutes': NotebookText,
  '/documents': FileText,
  '/treasury': Landmark,
  '/admin': Settings,
  '/retired': House,
  '/traffic': Radio,
}

/**
 * One nav link: the label text comes first in the markup and CSS draws the icon before it
 * (`order`), so the accessible name and the label text stay exactly what they were. Icons are decoration.
 */
function Item({ to, children }: { to: string; children: string }) {
  const Icon = ICONS[to]
  return (
    <NavLink to={to}>
      {children}
      {Icon && <Icon className="odz-nav__icon" size={20} strokeWidth={1.75} aria-hidden="true" focusable="false" />}
    </NavLink>
  )
}

/** Left sidebar list on desktop; fixed bottom tab bar at 760px and below (CSS only, see odz.css). */
export function AppNav() {
  const { capabilities, isAdmin, can, tierName, profile } = useAuth()
  const [treasury, setTreasury] = useState(false)
  // The Treasury tab appears only when the database says the caller has access (it ships dark: Admin only).
  useEffect(() => {
    if (!supabase || !profile || profile.status !== 'approved') return
    void supabase.rpc('treasury_access').then(({ data }) => setTreasury(data === 'own' || data === 'full'))
  }, [profile])
  if (profile?.status === 'retired') {
    // Retired accounts (MVA-238) reach only their own home and Traffic; the database denies the rest anyway.
    return (
      <nav className="odz-nav" aria-label="Main">
        <Item to="/retired">HOME</Item>
        <Item to="/traffic">TRAFFIC</Item>
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
        <Item key={item.to} to={item.to}>
          {item.label}
        </Item>
      ))}
      {showDesignations && <Item to="/designations">DESIGNATIONS</Item>}
      {showDesignations && <Item to="/motions">MOTIONS</Item>}
      {can('read_opportunities') && <Item to="/opportunities">OPPORTUNITIES</Item>}
      {(can("read_minutes") || can("write_minutes")) && <Item to="/minutes">MINUTES</Item>}
      {(can("read_documents") || can("publish_documents")) && <Item to="/documents">DOCS</Item>}
      {treasury && <Item to="/treasury">TREASURY</Item>}
      {showAdmin && <Item to="/admin">ADMIN</Item>}
    </nav>
  )
}
