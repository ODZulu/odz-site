/**
 * Phase 1 tabs only (Playbook D1/D2). Add MINUTES when its route exists.
 * Do not add MISSIONS, ATLAS or AAR: they are phase 2, and there are no dead tabs.
 */
export const navItems = [
  { to: '/hq', label: 'HQ' },
  { to: '/roster', label: 'ROSTER' },
  { to: '/calendar', label: 'CALENDAR' },
] as const

const SECTION_LABELS: Record<string, string> = {
  hq: 'HQ',
  roster: 'Roster',
  calendar: 'Calendar',
  designations: 'Designations',
  motions: 'Motions',
  opportunities: 'Opportunities',
  minutes: 'Minutes',
  documents: 'Docs',
  treasury: 'Treasury',
  admin: 'Admin',
  notifications: 'Notifications',
  traffic: 'Traffic',
  me: 'My profile',
  retired: 'Home',
  agenda: 'Agenda',
  settings: 'Settings',
}

const SUB_LABELS: Record<string, string> = {
  invites: 'Invites',
  pending: 'Pending',
  members: 'Members',
  tiers: 'Tiers',
  audit: 'Audit',
  new: 'New',
  edit: 'Edit',
  notifications: 'Notifications',
}

/** Breadcrumb trail for the top bar: the section, then a known sub-page. Ids and slugs are never shown. */
export function crumbs(pathname: string): string[] {
  const [section, sub] = pathname.split('/').filter(Boolean)
  const first = section ? (SECTION_LABELS[section] ?? '') : ''
  if (!first) return []
  const second = sub ? SUB_LABELS[sub] : undefined
  return second && second !== first ? [first, second] : [first]
}
