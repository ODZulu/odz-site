import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Test-only backend helpers (MVA-205). They use the service-role key of a LOCAL Supabase stack
 * (from `supabase status`, passed in the environment). That key never reaches the client bundle:
 * the dev server is started with only the URL and the anon key.
 *
 * Everything created here is obviously fake, uses the `e2e-` prefix, and is removed by cleanup().
 */

const url = process.env.E2E_SUPABASE_URL
const anonKey = process.env.E2E_SUPABASE_ANON_KEY
const serviceKey = process.env.E2E_SUPABASE_SERVICE_KEY

export const hasBackend = Boolean(url && anonKey && serviceKey)

// Refuse anything that is not a local stack, so this can never run against dev or prod by accident.
if (hasBackend && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url as string)) {
  throw new Error('E2E_SUPABASE_URL must be a local Supabase stack (127.0.0.1 or localhost).')
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } }

export function admin(): SupabaseClient {
  return createClient(url as string, serviceKey as string, opts)
}

/** An anon-key client, optionally signed in as a seeded user. */
export async function asUser(email?: string, password?: string): Promise<SupabaseClient> {
  const c = createClient(url as string, anonKey as string, opts)
  if (email && password) {
    const { error } = await c.auth.signInWithPassword({ email, password })
    if (error) throw new Error('e2e sign-in failed')
  }
  return c
}

export const PREFIX = 'e2e-'
/** Meets the 12-character rule. Fake, local-only. */
export const PASSWORD = 'e2e-Fake-Passw0rd!'

let counter = 0
export function uniq(): string {
  counter += 1
  return `${Date.now().toString(36)}${counter}`.slice(-8)
}

export const fakeEmail = (tag: string) => `${PREFIX}${tag}-${uniq()}@example.invalid`
/** E2E-A + 8 chars: within the 2-24 character callsign rule. */
export const fakeCallsign = () => `E2E-${uniq().toUpperCase()}`

export async function tierId(name: string): Promise<string> {
  const { data, error } = await admin().from('tiers').select('id').eq('name', name).single()
  if (error || !data) throw new Error(`tier ${name} missing`)
  return data.id as string
}

/** Creates an invite directly (service role) and returns its code. */
export async function createInvite(opts2: { tier?: string; expiresAt?: string; revoked?: boolean } = {}): Promise<string> {
  const row: Record<string, unknown> = { tier_id: await tierId(opts2.tier ?? 'Recruit'), note: `${PREFIX}invite` }
  if (opts2.expiresAt) row.expires_at = opts2.expiresAt
  const { data, error } = await admin().from('invites').insert(row).select('id, code').single()
  if (error || !data) throw new Error('could not create invite')
  if (opts2.revoked) {
    const r = await admin().from('invites').update({ revoked_at: new Date().toISOString() }).eq('id', data.id)
    if (r.error) throw new Error('could not revoke invite')
  }
  return data.code as string
}

export type SeedLevel = 'pending' | 'pending-setup-done' | 'recruit' | 'member' | 'command' | 'admin'

export type SeededUser = { id: string; email: string; password: string; callsign: string }

/**
 * Creates a user the way real signup does (a valid invite in the metadata), then moves it to the
 * requested state with trusted updates. The signup trigger builds the profile.
 */
export async function seedUser(level: SeedLevel, tag: string = level): Promise<SeededUser> {
  const a = admin()
  if (level === 'admin') await ensureKeepAdmin()
  const email = fakeEmail(tag)
  const callsign = fakeCallsign()
  const code = await createInvite()
  const { data, error } = await a.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { invite_code: code },
  })
  if (error || !data.user) throw new Error('could not create e2e user')
  const id = data.user.id

  if (level !== 'pending') {
    await setupDone(id, callsign)
  }
  if (level === 'recruit' || level === 'member' || level === 'command' || level === 'admin') {
    await a.from('profiles').update({ status: 'approved' }).eq('id', id)
  }
  if (level === 'member') await a.from('profiles').update({ tier_id: await tierId('Member') }).eq('id', id)
  if (level === 'command') {
    await a.from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', id)
    await a.from('profiles').update({ tier_id: await tierId('Command') }).eq('id', id)
  }
  if (level === 'admin') await a.from('profiles').update({ is_admin: true }).eq('id', id)
  return { id, email, password: PASSWORD, callsign }
}

/**
 * The last-admin rule applies to everyone, so an e2e admin can only be deleted while another admin
 * exists. One permanent admin (no e2e- prefix, never used to sign in) lives on the throwaway local stack.
 */
async function ensureKeepAdmin(): Promise<void> {
  const a = admin()
  const email = 'keep-admin@example.invalid'
  const existing = await a.from('profiles').select('id').eq('is_admin', true).limit(50)
  const ids = (existing.data ?? []).map((r: { id: string }) => r.id)
  if (ids.length) {
    const users = await a.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (users.data.users.some((u) => u.email === email && ids.includes(u.id))) return
  }
  const code = await createInvite()
  const { data, error } = await a.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { invite_code: code } })
  if (error || !data.user) throw new Error('could not create the keep-alive admin')
  await a.from('profiles').update({ status: 'approved', is_admin: true, setup_complete: true, callsign: 'KEEP-ADMIN' }).eq('id', data.user.id)
}

async function setupDone(id: string, callsign: string): Promise<void> {
  const a = admin()
  const priv = await a.from('member_private').insert({
    profile_id: id,
    legal_name: 'E2E Fake Person',
    dob: '2000-01-01',
    phone: '555 0100',
    allergies: 'None',
    emergency_name: 'E2E Fake Contact',
    emergency_relationship: 'Friend',
    emergency_phone: '555 0101',
  })
  if (priv.error) throw new Error('could not seed private row')
  const prof = await a.from('profiles').update({ callsign, setup_complete: true }).eq('id', id)
  if (prof.error) throw new Error('could not seed profile')
}

/** Clears failed-guess counters so a lockout in one test cannot affect the next. */
export async function resetInviteAttempts(): Promise<void> {
  await admin().from('invite_attempts').delete().neq('key', '')
}

/** Removes everything the run created: users (profiles and private rows cascade), audit rows, invites. */
export async function cleanup(): Promise<void> {
  const a = admin()
  const ids: string[] = []
  for (let page = 1; ; page++) {
    const { data, error } = await a.auth.admin.listUsers({ page, perPage: 200 })
    if (error || !data.users.length) break
    for (const u of data.users) if (u.email?.startsWith(PREFIX)) ids.push(u.id)
    if (data.users.length < 200) break
  }
  if (ids.length) {
    await a.from('profile_audit').delete().in('profile_id', ids)
    for (const id of ids) await a.auth.admin.deleteUser(id)
  }
  const inv = await a.from('invites').select('id').like('note', `${PREFIX}%`)
  const invIds = (inv.data ?? []).map((r: { id: string }) => r.id)
  if (invIds.length) {
    await a.from('invite_audit').delete().in('invite_id', invIds)
    await a.from('invites').delete().in('id', invIds)
  }
  await resetInviteAttempts()
}
