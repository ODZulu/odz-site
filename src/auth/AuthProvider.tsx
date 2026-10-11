import type { Session } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AccessState, AccountStatus } from '../lib/access'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

export type Profile = {
  callsign: string | null
  status: AccountStatus
  setup_complete: boolean
  is_admin: boolean
  tier_id: string | null
}

type AuthValue = {
  configured: boolean
  loading: boolean
  session: Session | null
  profile: Profile | null
  /** Approved accounts only (pending accounts cannot read the tiers table). */
  tierName: string | null
  /** Capability keys the account holds (admins hold all). The UI hides; RLS is the control. */
  capabilities: string[]
  can: (capability: string) => boolean
  isAdmin: boolean
  access: AccessState
  /** Returns a message to show, or null on success. Never says which of email or password was wrong. */
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const idle: AuthValue = {
  configured: false,
  loading: false,
  session: null,
  profile: null,
  tierName: null,
  capabilities: [],
  can: () => false,
  isAdmin: false,
  access: { loading: false, signedIn: false, profile: null },
  signIn: async () => 'Sign-in is not available.',
  signOut: async () => {},
  refreshProfile: async () => {},
}

const AuthContext = createContext<AuthValue>(idle)

export const useAuth = () => useContext(AuthContext)

type Loaded = { uid: string; profile: Profile | null; tierName: string | null; capabilities: string[] }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionReady, setSessionReady] = useState(!supabase)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!supabase) return
    let alive = true
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setSession(data.session)
      setSessionReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => {
      alive = false
      data.subscription.unsubscribe()
    }
  }, [])

  const uid = session?.user.id ?? null

  const loadProfile = useCallback(async () => {
    if (!supabase || !uid) return
    const { data } = await supabase
      .from('profiles')
      .select('callsign,status,setup_complete,is_admin,tier_id')
      .eq('id', uid)
      .maybeSingle()
    const profile = (data as Profile | null) ?? null
    let tierName: string | null = null
    let capabilities: string[] = []
    if (profile?.status === 'approved') {
      if (profile.tier_id) {
        const tier = await supabase.from('tiers').select('name').eq('id', profile.tier_id).maybeSingle()
        tierName = (tier.data as { name: string } | null)?.name ?? null
      }
      const caps = await supabase.rpc('my_capabilities')
      capabilities = Array.isArray(caps.data) ? (caps.data as string[]) : []
    }
    setLoaded({ uid, profile, tierName, capabilities })
  }, [uid])

  useEffect(() => {
    void loadProfile()
  }, [loadProfile])

  const current = uid !== null && loaded?.uid === uid ? loaded : null
  const loading = !sessionReady || (uid !== null && current === null)
  const profile = current?.profile ?? null
  const capabilities = useMemo(() => current?.capabilities ?? [], [current])
  const isAdmin = profile?.is_admin === true && profile.status === 'approved'

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return 'Sign-in is not available.'
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (!error) return null
    // Only a real credentials failure says "incorrect"; a misconfigured or unreachable backend must not look like a typo.
    return error.code === 'invalid_credentials' || error.status === 400
      ? 'Email or password is incorrect.'
      : 'Could not reach the sign-in service. Try again, and tell Command if it keeps happening.'
  }, [])

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
    setLoaded(null)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      configured: isSupabaseConfigured,
      loading,
      session,
      profile,
      tierName: current?.tierName ?? null,
      capabilities,
      can: (capability: string) => isAdmin || capabilities.includes(capability),
      isAdmin,
      access: { loading, signedIn: session !== null, profile },
      signIn,
      signOut,
      refreshProfile: loadProfile,
    }),
    [loading, session, profile, current, capabilities, isAdmin, signIn, signOut, loadProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
