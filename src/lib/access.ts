/**
 * Where an account may be, decided from its state (MVA-199). This is navigation only: what a
 * user can actually read is decided by RLS in the database.
 *
 * Order matters: a suspended or removed account is denied first, then setup must be complete (it is shown
 * once, right after the first sign-in), then pending accounts wait, retired accounts get their limited
 * home (MVA-238), then approved accounts enter.
 */

export type AccountStatus = 'pending' | 'approved' | 'suspended' | 'removed' | 'retired'

export type AccessState = {
  loading: boolean
  signedIn: boolean
  profile: { status: AccountStatus; setup_complete: boolean } | null
}

/** 'shared' pages (Traffic, notifications) are open to approved and retired accounts alike. */
export type Page = 'app' | 'setup' | 'pending' | 'denied' | 'retired' | 'shared'

export const HOME = '/hq'
export const RETIRED_HOME = '/retired'

/** The one page this account belongs on, or null while still loading. */
export function homeFor(state: AccessState): string | null {
  if (state.loading) return null
  if (!state.signedIn || !state.profile) return '/login'
  if (state.profile.status === 'suspended' || state.profile.status === 'removed') return '/denied'
  if (!state.profile.setup_complete) return '/setup'
  if (state.profile.status === 'pending') return '/pending'
  if (state.profile.status === 'retired') return RETIRED_HOME
  return HOME
}

const pagePath: Record<Exclude<Page, 'shared'>, string> = {
  app: HOME,
  setup: '/setup',
  pending: '/pending',
  denied: '/denied',
  retired: RETIRED_HOME,
}

/** Redirect target if `page` is not where this account belongs; null means render it (or keep waiting). */
export function redirectFor(state: AccessState, page: Page): string | null {
  const home = homeFor(state)
  if (home === null) return null
  if (page === 'shared') return home === HOME || home === RETIRED_HOME ? null : home
  return home === pagePath[page] ? null : home
}

/** For public pages (login, join): a signed-in account goes to where it belongs. */
export function redirectIfSignedIn(state: AccessState): string | null {
  if (state.loading || !state.signedIn || !state.profile) return null
  return homeFor(state)
}
