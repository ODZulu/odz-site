import { expect, test, type Page } from '@playwright/test'
import {
  admin,
  asUser,
  cleanup,
  createInvite,
  fakeCallsign,
  fakeEmail,
  hasBackend,
  PASSWORD,
  resetInviteAttempts,
  seedUser,
  tierId,
} from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await admin().from('traffic').delete().like('title', 'E2E %')
  await cleanup()
})

async function signIn(page: Page, u: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

test('invite as Support: callsign-only setup, approval, sign in, and nothing gated is readable', async ({ page }) => {
  const code = await createInvite({ tier: 'Support' })
  const email = fakeEmail('support-join')
  const callsign = fakeCallsign()

  await page.goto(`/join/${code}`)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByLabel('Callsign')).toBeVisible()
  // Callsign only: no legal name, date of birth, allergies or emergency contact.
  await expect(page.getByLabel('Full legal name')).toHaveCount(0)
  await expect(page.getByLabel('Date of birth')).toHaveCount(0)
  await expect(page.getByLabel('Emergency contact name')).toHaveCount(0)
  await page.getByLabel('Callsign').fill(callsign)
  await page.getByRole('button', { name: 'Save and continue' }).click()
  await expect(page).toHaveURL(/\/pending$/)

  // Dax approves the account as for any other tier (D17).
  const found = await admin().from('profiles').select('id,tier_id').eq('callsign', callsign).single()
  expect(found.data?.tier_id).toBe(await tierId('Support'))
  await admin().from('profiles').update({ status: 'approved' }).eq('id', found.data?.id)
  const priv = await admin().from('member_private').select('profile_id').eq('profile_id', found.data?.id)
  expect(priv.data).toHaveLength(0)

  // The browser is still signed in from signup; a reload picks up the approval.
  await page.reload()
  await expect(page).toHaveURL(/\/hq$/)
  await page.goto('/roster')
  await expect(page.getByRole('link', { name: callsign })).toBeVisible()
  await expect(page.getByText('Support', { exact: true }).first()).toBeVisible()

  // Server side: no capabilities, no gated rows.
  const c = await asUser(email, PASSWORD)
  expect((await c.rpc('my_capabilities')).data).toEqual([])
  expect((await c.from('event_details').select('event_id')).data ?? []).toHaveLength(0)
  expect((await c.from('minutes').select('id')).data ?? []).toHaveLength(0)
  expect((await c.from('documents').select('id')).data ?? []).toHaveLength(0)
  expect((await c.from('member_private').select('profile_id')).data ?? []).toHaveLength(0)
})

test('Support reads Traffic but cannot post, and cannot read other members private data', async () => {
  const sup = await seedUser('support', 'sup-read')
  const other = await seedUser('member', 'sup-read-other')
  expect((await admin().from('traffic').insert({ title: 'E2E Support read', body: 'e2e body' })).error).toBeNull()
  const c = await asUser(sup.email, sup.password)
  const traffic = await c.from('traffic').select('title').eq('title', 'E2E Support read')
  expect(traffic.data).toHaveLength(1)
  const priv = await c.from('member_private').select('profile_id').eq('profile_id', other.id)
  expect(priv.data ?? []).toHaveLength(0)
  const post = await c.from('traffic').insert({ title: 'E2E Support post', body: 'x' })
  expect(post.error).not.toBeNull()
})

test('Command moves a Support account to Member with a note; setup re-opens; the move is logged', async ({ page, browser }) => {
  const cmd = await seedUser('command', 'sup-cmd')
  const sup = await seedUser('support', 'sup-move')
  await signIn(page, cmd)
  await page.goto('/admin/members')
  await page.getByLabel(`Tier for ${sup.callsign}`).selectOption({ label: 'Member' })
  // Nothing happens until a note is written and confirmed.
  const confirm = page.getByRole('button', { name: `Confirm: move ${sup.callsign}` })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Note (required)').fill('e2e: now plays')
  await confirm.click()
  await expect(page.getByLabel('Note (required)')).toHaveCount(0)

  const row = await admin().from('profiles').select('tier_id,setup_complete').eq('id', sup.id).single()
  expect(row.data?.tier_id).toBe(await tierId('Member'))
  expect(row.data?.setup_complete).toBe(false)
  const log = await admin().from('profile_audit').select('old_value,new_value,note,actor_id').eq('profile_id', sup.id).eq('event', 'tier').eq('actor_id', cmd.id)
  expect(log.data).toEqual([{ old_value: 'Support', new_value: 'Member', note: 'e2e: now plays', actor_id: cmd.id }])

  // The moved account goes back through full setup before it counts anywhere.
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await p2.goto('/login')
  await p2.getByLabel('Email').fill(sup.email)
  await p2.getByLabel('Password').fill(sup.password)
  await p2.getByRole('button', { name: 'Sign in' }).click()
  await expect(p2).toHaveURL(/\/setup$/)
  await expect(p2.getByLabel('Full legal name')).toBeVisible()
  await ctx.close()
})

test('Command and Old Guard are not moved to or from Support, and direct updates are refused', async ({ page }) => {
  const cmd = await seedUser('command', 'sup-bar-cmd')
  const sup = await seedUser('support', 'sup-bar')
  const asCmd = await asUser(cmd.email, cmd.password)

  const direct = await asCmd.from('profiles').update({ tier_id: await tierId('Member') }).eq('id', sup.id)
  expect(direct.error).not.toBeNull()
  const viaRpc = await asCmd.rpc('move_support_tier', { p_profile: sup.id, p_tier: await tierId('Old Guard'), p_note: 'e2e: barred' })
  expect(viaRpc.error).not.toBeNull()
  const short = await asCmd.rpc('move_support_tier', { p_profile: sup.id, p_tier: await tierId('Member'), p_note: 'x' })
  expect(short.error).not.toBeNull()
  const row = await admin().from('profiles').select('tier_id').eq('id', sup.id).single()
  expect(row.data?.tier_id).toBe(await tierId('Support'))

  // The UI says why for the barred move and offers no note form.
  await signIn(page, cmd)
  await page.goto('/admin/members')
  await page.getByLabel(`Tier for ${sup.callsign}`).selectOption({ label: 'Old Guard' })
  await expect(page.getByRole('alert')).toContainText('cannot be moved')
  await expect(page.getByLabel('Note (required)')).toHaveCount(0)
})

test('a plain Member cannot move anyone to Support', async () => {
  const mem = await seedUser('member', 'sup-mem')
  const target = await seedUser('member', 'sup-mem-target')
  const asMem = await asUser(mem.email, mem.password)
  const r = await asMem.rpc('move_support_tier', { p_profile: target.id, p_tier: await tierId('Support'), p_note: 'e2e: refused' })
  expect(r.error).not.toBeNull()
  const row = await admin().from('profiles').select('tier_id').eq('id', target.id).single()
  expect(row.data?.tier_id).toBe(await tierId('Member'))
})
