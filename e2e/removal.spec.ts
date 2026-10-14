import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await admin().from('traffic').delete().like('title', 'E2E %')
  await cleanup()
})

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

const memberPage = (page: Page, u: SeededUser) => page.goto(`/roster/${encodeURIComponent(u.callsign)}`)

async function removeViaUi(page: Page, u: SeededUser, reason: string) {
  await memberPage(page, u)
  await page.getByLabel('Reason (required)').fill(reason)
  await page.getByRole('button', { name: 'Remove member' }).click()
  await page.getByRole('button', { name: `Confirm: remove ${u.callsign}` }).click()
  await expect(page).toHaveURL(/\/roster$/)
}

test('Admin removes a member: access ends, private details are purged, the roster entry goes', async ({ page }) => {
  const boss = await seedUser('admin', 'rm-admin')
  const target = await seedUser('member', 'rm-target')
  await signIn(page, boss)

  await memberPage(page, target)
  // Nothing is offered until a reason is written, and the confirm step is separate.
  await expect(page.getByRole('button', { name: 'Remove member' })).toBeDisabled()
  await removeViaUi(page, target, 'e2e: left the team')

  await expect(page.getByRole('link', { name: target.callsign })).toHaveCount(0)

  const row = await admin().from('profiles').select('status,removed_at,removed_by,is_admin').eq('id', target.id).single()
  expect(row.data).toMatchObject({ status: 'removed', removed_by: boss.id, is_admin: false })
  expect(row.data?.removed_at).toBeTruthy()
  const priv = await admin().from('member_private').select('profile_id').eq('profile_id', target.id)
  expect(priv.data).toHaveLength(0)

  // The reason is in the Admin log and the Audit tab.
  const log = await admin().from('member_removals').select('reason,action').eq('profile_id', target.id)
  expect(log.data).toEqual([{ reason: 'e2e: left the team', action: 'removed' }])
  await page.goto('/admin/audit')
  await expect(page.getByText('e2e: left the team')).toBeVisible()
})

test('a removed member cannot sign in, and a session opened earlier reads nothing', async ({ page, browser }) => {
  const boss = await seedUser('admin', 'rm-lock-admin')
  const target = await seedUser('member', 'rm-lock')
  const before = await asUser(target.email, target.password)

  await signIn(page, boss)
  await removeViaUi(page, target, 'e2e: removed for lock-out check')

  await expect(asUser(target.email, target.password)).rejects.toThrow()
  const events = await before.from('events').select('id')
  expect(events.data ?? []).toHaveLength(0)

  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await p2.goto('/login')
  await p2.getByLabel('Email').fill(target.email)
  await p2.getByLabel('Password').fill(target.password)
  await p2.getByRole('button', { name: 'Sign in' }).click()
  await expect(p2).toHaveURL(/\/login$/)
  await expect(p2.getByText('Email or password is incorrect.')).toBeVisible()
  await ctx.close()
})

test('Command sees the member but is not offered removal, and the RPC refuses', async ({ page }) => {
  const cmd = await seedUser('command', 'rm-cmd')
  const target = await seedUser('member', 'rm-cmd-target')
  await signIn(page, cmd)
  await memberPage(page, target)
  await expect(page.getByRole('heading', { name: target.callsign })).toBeVisible()
  await expect(page.getByText('Remove member')).toHaveCount(0)

  const as = await asUser(cmd.email, cmd.password)
  const r = await as.rpc('remove_member', { p_profile: target.id, p_reason: 'e2e: command attempt' })
  expect(r.error).not.toBeNull()
  const row = await admin().from('profiles').select('status').eq('id', target.id).single()
  expect(row.data?.status).toBe('approved')
})

test('anon and members are refused by both RPCs', async () => {
  const target = await seedUser('member', 'rm-anon-target')
  const other = await seedUser('member', 'rm-anon-other')
  for (const c of [await asUser(), await asUser(other.email, other.password)]) {
    expect((await c.rpc('remove_member', { p_profile: target.id, p_reason: 'e2e: refused' })).error).not.toBeNull()
    expect((await c.rpc('delete_removed_member', { p_profile: target.id, p_reason: 'e2e: refused' })).error).not.toBeNull()
  }
  const row = await admin().from('profiles').select('status').eq('id', target.id).single()
  expect(row.data?.status).toBe('approved')
})

test('an Admin cannot remove themselves', async ({ page }) => {
  const boss = await seedUser('admin', 'rm-self')
  await signIn(page, boss)
  await memberPage(page, boss)
  await expect(page.getByText('You cannot remove yourself.')).toBeVisible()
  await expect(page.getByLabel('Reason (required)')).toHaveCount(0)
  const r = await (await asUser(boss.email, boss.password)).rpc('remove_member', { p_profile: boss.id, p_reason: 'e2e: self' })
  expect(r.error).not.toBeNull()
})

test('authored traffic is attributed to Former member after removal and after hard delete', async ({ page, browser }) => {
  const boss = await seedUser('admin', 'rm-fm-admin')
  const author = await seedUser('command', 'rm-fm-author')
  const viewer = await seedUser('member', 'rm-fm-viewer')
  const ins = await admin().from('traffic').insert({ title: 'E2E Former', body: 'e2e body', created_by: author.id })
  expect(ins.error).toBeNull()

  await signIn(page, boss)
  await removeViaUi(page, author, 'e2e: former member check')

  const ctx = await browser.newContext()
  const vp = await ctx.newPage()
  await signIn(vp, viewer)
  await vp.goto('/traffic')
  await expect(vp.getByText('E2E Former')).toBeVisible()
  await expect(vp.getByText(/Former member/)).toBeVisible()

  // Hard delete from the Admin screen: reason, callsign typed back, confirm.
  await page.goto('/admin/members')
  await page.getByRole('button', { name: `Delete ${author.callsign}...` }).click()
  await page.getByLabel('Reason (required)').fill('e2e: privacy request')
  const confirm = page.getByRole('button', { name: 'Delete for good' })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Type the callsign to confirm').fill(author.callsign)
  await confirm.click()
  await page.getByRole('button', { name: `Confirm: delete ${author.callsign}` }).click()
  await expect(page.getByRole('button', { name: `Delete ${author.callsign}...` })).toHaveCount(0)

  const gone = await admin().auth.admin.getUserById(author.id)
  expect(gone.data.user).toBeNull()
  const post = await admin().from('traffic').select('created_by').eq('title', 'E2E Former').single()
  expect(post.data?.created_by).toBeNull()
  const log = await admin().from('member_removals').select('action').eq('profile_id', author.id).order('created_at')
  expect(log.data?.map((r) => r.action)).toEqual(['removed', 'deleted'])

  await vp.reload()
  await expect(vp.getByText('E2E Former')).toBeVisible()
  await expect(vp.getByText(/Former member/)).toBeVisible()
  await ctx.close()
})
