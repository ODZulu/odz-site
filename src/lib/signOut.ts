/**
 * Signing out (MVA-300). The session is cleared and the user is sent to the login page, whatever page
 * they were on. Route guards already redirect the gated pages, but public pages such as the calendar
 * simply re-render as the public view on the same URL, which looked like a half-empty member page.
 */
export const LOGIN_PATH = '/login'

type AuthLike = { signOut: (options?: { scope: 'global' | 'local' | 'others' }) => Promise<{ error: unknown } | void> }

type Steps = {
  auth: AuthLike | undefined
  /** Drops the cached profile and capabilities held in memory. */
  clear: () => void
  go: (path: string) => void
}

/**
 * Revokes the session on the server, and if that fails (offline, server error) still clears it on this
 * device, so signing out always works. Then forgets the in-memory profile and goes to login.
 */
export async function performSignOut({ auth, clear, go }: Steps): Promise<void> {
  if (auth) {
    let failed = false
    try {
      const result = await auth.signOut()
      failed = Boolean(result && result.error)
    } catch {
      failed = true
    }
    if (failed) {
      try {
        await auth.signOut({ scope: 'local' })
      } catch {
        // Nothing more can be done here; the screen still leaves the member area below.
      }
    }
  }
  clear()
  go(LOGIN_PATH)
}

/**
 * A page restored from the browser's back/forward cache is the old DOM, not a fresh load, so it can
 * still show member data after a sign-out. Reload it when the session is gone.
 */
export const shouldReloadOnRestore = (persisted: boolean, hasSession: boolean): boolean => persisted && !hasSession
