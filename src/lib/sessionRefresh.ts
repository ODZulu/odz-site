/**
 * When an open session re-reads the member's profile, tier and capabilities (MVA-252), so a role
 * change made elsewhere shows up without signing out. Display and navigation only: RLS is the control.
 */
import type { AccountStatus } from './access'

export type RefreshTrigger = 'focus' | 'route' | 'interval'

/** A route change refreshes only if the last read is older than this. */
export const ROUTE_MIN_MS = 60_000
/** Never go longer than this between reads while the tab is open. */
export const INTERVAL_MS = 5 * 60_000
/** Focus and visibility events often arrive together; collapse them. */
export const FOCUS_MIN_MS = 3_000
/** How often the interval trigger checks the clock. */
export const TICK_MS = 60_000

export function shouldRefresh(trigger: RefreshTrigger, now: number, lastAt: number): boolean {
  const age = now - lastAt
  if (trigger === 'focus') return age >= FOCUS_MIN_MS
  if (trigger === 'route') return age > ROUTE_MIN_MS
  return age >= INTERVAL_MS
}

/** Suspended and removed accounts are signed out on the next refresh. */
export function mustSignOut(status: AccountStatus | null | undefined): boolean {
  return status === 'suspended' || status === 'removed'
}

type Snapshot = {
  profile: { callsign: string | null; status: string; setup_complete: boolean; is_admin: boolean; tier_id: string | null } | null
  tierName: string | null
  capabilities: string[]
}

/** True when nothing a screen shows has changed, so the refresh can skip a re-render. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  const pa = a.profile
  const pb = b.profile
  if ((pa === null) !== (pb === null)) return false
  if (pa && pb) {
    if (pa.callsign !== pb.callsign || pa.status !== pb.status || pa.setup_complete !== pb.setup_complete || pa.is_admin !== pb.is_admin || pa.tier_id !== pb.tier_id) return false
  }
  if (a.tierName !== b.tierName) return false
  if (a.capabilities.length !== b.capabilities.length) return false
  const set = new Set(a.capabilities)
  return b.capabilities.every((c) => set.has(c))
}
