/**
 * Where an account may be, decided from its state (MVA-199). This is navigation only: what a
 * user can actually read is decided by RLS in the database.
 *
 * Order matters: a suspended account is denied first, then setup must be complete (it is shown
 * once, right after the first sign-in), then pending accounts wait, then approved accounts enter.
 */

export type AccountStatus = 'pending' | 'approved' | 'suspended'

export type AccessState = {
  loading: boolean
  signedIn: boolean
  profile: { status: AccountStatus; setup_complete: boolean } | null
}

export type Page = 'app' | 'setup' | 'pending' | 'denied'

export const HOME = '/hq'

/** The one page this account belongs on, or null while still loading. */
export function homeFor(state: AccessState): string | null {
  if (state.loading) return null
  if (!state.signedIn || !state.profile) return '/login'
  if (state.profile.status === 'suspended') return '/denied'
  if (!state.profile.setup_complete) return '/setup'
  if (state.profile.status === 'pending') return '/pending'
  return HOME
}

const pagePath: Record<Page, string> = { app: HOME, setup: '/setup', pending: '/pending', denied: '/denied' }

/** Redirect target if `page` is not where this account belongs; null means render it (or keep waiting). */
export function redirectFor(state: AccessState, page: Page): string | null {
  const home = homeFor(state)
  if (home === null) return null
  return home === pagePath[page] ? null : home
}

/** For public pages (login, join): a signed-in account goes to where it belongs. */
export function redirectIfSignedIn(state: AccessState): string | null {
  if (state.loading || !state.signedIn || !state.profile) return null
  return homeFor(state)
}
