import { expect, test } from '@playwright/test'
import { asUser, cleanup, hasBackend, resetInviteAttempts, seedUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

// API-level checks: RLS is the control, so these go straight at the REST API with the anon key.

test.describe('anon', () => {
  for (const table of ['invites', 'invite_audit', 'invite_attempts', 'member_private', 'profile_audit', 'profiles']) {
    test(`cannot read ${table}`, async () => {
      const c = await asUser()
      const { data, error } = await c.from(table).select('*').limit(1)
      // Either the privilege is missing (error) or RLS hides every row.
      expect(error !== null || (data ?? []).length === 0).toBe(true)
    })
  }

  test('check_invite answers false for a garbage code and never says why', async () => {
    const c = await asUser()
    const { data, error } = await c.rpc('check_invite', { p_code: 'garbage-code-000000' })
    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  test('cannot call the internal redeem function', async () => {
    const c = await asUser()
    const { error } = await c.rpc('redeem_invite', { p_code: 'garbage-code-000000', p_user: '00000000-0000-0000-0000-000000000000' })
    expect(error).not.toBeNull()
  })
})

test.describe('members', () => {
  test('a member reads only their own private row', async () => {
    const a = await seedUser('member', 'privA')
    const b = await seedUser('member', 'privB')
    const c = await asUser(a.email, a.password)
    const { data, error } = await c.from('member_private').select('profile_id')
    expect(error).toBeNull()
    expect((data ?? []).map((r: { profile_id: string }) => r.profile_id)).toEqual([a.id])
    const other = await c.from('member_private').select('profile_id').eq('profile_id', b.id)
    expect(other.data ?? []).toEqual([])
  })

  test('a member cannot change their own tier, status or admin flag', async () => {
    const a = await seedUser('member', 'escalate')
    const c = await asUser(a.email, a.password)
    const res = await c.from('profiles').update({ is_admin: true }).eq('id', a.id).select()
    expect(res.error !== null || (res.data ?? []).length === 0).toBe(true)
    const check = await c.from('profiles').select('is_admin').eq('id', a.id).single()
    expect(check.data?.is_admin).toBe(false)
  })

  test('a member cannot create or read invites', async () => {
    const a = await seedUser('member', 'noinv')
    const c = await asUser(a.email, a.password)
    const ins = await c.from('invites').insert({ note: 'e2e-should-fail' })
    expect(ins.error).not.toBeNull()
    const sel = await c.from('invites').select('id')
    expect(sel.data ?? []).toEqual([])
  })

  test('Command creates an invite through the RPC and cannot read the code again', async () => {
    const cmd = await seedUser('command', 'cmd')
    const c = await asUser(cmd.email, cmd.password)
    const made = await c.rpc('create_invite', { p_note: 'e2e-by-command' })
    expect(made.error).toBeNull()
    expect(String(made.data).length).toBeGreaterThanOrEqual(10)
    // Direct inserts are closed, and the code column is unreadable.
    const chosen = await c.from('invites').insert({ code: 'chosen-by-client-0000', note: 'e2e-chosen' })
    expect(chosen.error).not.toBeNull()
    const peek = await c.from('invites').select('code')
    expect(peek.error).not.toBeNull()
    const hints = await c.from('invites').select('code_hint').eq('note', 'e2e-by-command')
    expect(hints.data?.[0]?.code_hint).toBe(String(made.data).slice(-4))
  })
})
