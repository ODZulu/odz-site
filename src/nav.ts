/**
 * Phase 1 tabs only (Playbook D1/D2). Add MINUTES when its route exists.
 * Do not add MISSIONS, ATLAS or AAR: they are phase 2, and there are no dead tabs.
 */
export const navItems = [
  { to: '/hq', label: 'HQ' },
  { to: '/roster', label: 'ROSTER' },
  { to: '/calendar', label: 'CALENDAR' },
] as const
