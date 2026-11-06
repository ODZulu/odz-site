import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isRecoveryHash, markRecovery } from './recovery'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

// Null when env vars are missing (e.g. a Vercel preview before Dax sets them) so the app still renders.
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null

// Remember, for this tab only, that it arrived through a password-recovery link (MVA-200). Subscribed
// right away so the event is not missed while the link is being read.
// The link's own fragment is available synchronously, so the mark does not depend on event timing.
if (supabase && typeof window !== 'undefined' && isRecoveryHash(window.location.hash)) markRecovery()
supabase?.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') markRecovery()
})
