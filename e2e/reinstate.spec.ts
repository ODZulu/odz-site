import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, tierId, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterEach(async () => {
  await cleanup()
})

async function signIn(page: Page, u: SeededUser, landing: RegExp = /\/hq$/) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(landing)
}

const memberPage = (page: Page, u: SeededUser) => page.goto(`/roster/${encodeURIComponent(u.callsign)}`)

async function removeViaUi(page: Page, u: SeededUser, reason: string) {
  await memberPage(page, u)
  await page.getByLabel('Reason (required)').fill(reason)
  await page.getByRole('button', { name: 'Remove member' }).click()
  await page.getByRole('button', { name: `Confirm: remove ${u.callsign}` }).click()
  await expect(page).toHaveURL(/\/roster$/)
}

test('Admin removes a member and reinstates them: they sign in again with the same password and land on setup', async ({ page, browser }) => {
  const boss = await seedUser('admin', 'ri-admin')
  const target = await seedUser('member', 'ri-target')
  await signIn(page, boss)
  await removeViaUi(page, target, 'e2e: removed for a reinstate check')
  await expect(asUser(target.email, target.password)).rejects.toThrow()

  await page.goto('/admin/members')
  const button = page.getByRole('button', { name: `Reinstate ${target.callsign}...` })
  await button.click()
  // A reason is required, with visible helper text, before the confirm step is offered.
  const group = page.getByRole('group', { name: 'Reinstate a removed member' })
  await expect(group.getByText('Give a reason of at least 3 characters.')).toBeVisible()
  await expect(group.getByRole('button', { name: 'Reinstate', exact: true })).toBeDisabled()
  await group.getByLabel('Reason (required)').fill('e2e: back after a break')
  await expect(group.getByText('Give a reason of at least 3 characters.')).toHaveCount(0)
  await group.getByRole('button', { name: 'Reinstate', exact: true }).click()
  await page.getByRole('button', { name: `Confirm: reinstate ${target.callsign}` }).click()
  await expect(page.getByRole('button', { name: `Reinstate ${target.callsign}...` })).toHaveCount(0)

  const row = await admin().from('profiles').select('status,removed_at,removed_by,setup_complete,tier_id').eq('id', target.id).single()
  expect(row.data).toMatchObject({ status: 'approved', removed_at: null, removed_by: null, setup_complete: false, tier_id: await tierId('Member') })
  const audit = await admin().from('profile_audit').select('event,note,old_value,new_value').eq('profile_id', target.id).eq('event', 'member_reinstated')
  expect(audit.data).toEqual([{ event: 'member_reinstated', note: 'e2e: back after a break', old_value: 'Member', new_value: 'Member' }])

  // The Audit tab shows it.
  await page.goto('/admin/audit')
  await expect(page.getByText('e2e: back after a break')).toBeVisible()

  // Their old password works again, and they go straight to the setup form.
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await signIn(p2, target, /\/setup$/)
  await ctx.close()
})

test('a removed Old Guard member comes back as a Member and takes no seat; the roster lists them again', async ({ page }) => {
  const boss = await seedUser('admin', 'ri-og-admin')
  const og = await seedUser('member', 'ri-og')
  expect((await admin().from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', og.id)).error).toBeNull()
  await signIn(page, boss)
  await removeViaUi(page, og, 'e2e: removed seat holder')

  await page.goto('/admin/members')
  await page.getByRole('button', { name: `Reinstate ${og.callsign}...` }).click()
  const group = page.getByRole('group', { name: 'Reinstate a removed member' })
  // The screen says plainly that the seat does not come back.
  await expect(group.getByText(/returns as Member.*Old Guard seat is not restored/)).toBeVisible()
  await group.getByLabel('Reason (required)').fill('e2e: back, was Old Guard')
  await group.getByRole('button', { name: 'Reinstate', exact: true }).click()
  await page.getByRole('button', { name: `Confirm: reinstate ${og.callsign}` }).click()
  await expect(page.getByRole('button', { name: `Reinstate ${og.callsign}...` })).toHaveCount(0)

  const row = await admin().from('profiles').select('status,tier_id').eq('id', og.id).single()
  expect(row.data).toMatchObject({ status: 'approved', tier_id: await tierId('Member') })

  await page.goto('/roster')
  await expect(page.getByRole('link', { name: og.callsign })).toBeVisible()
})

test('only an Admin can reinstate: Command and Members are refused by the RPC, and an active account is rejected', async ({ page }) => {
  const cmd = await seedUser('command', 'ri-cmd')
  const boss = await seedUser('admin', 'ri-deny-admin')
  const gone = await seedUser('member', 'ri-deny-gone')
  const live = await seedUser('member', 'ri-deny-live')
  await signIn(page, boss)
  await removeViaUi(page, gone, 'e2e: removed for the permission check')

  const asCmd = await asUser(cmd.email, cmd.password)
  const refused = await asCmd.rpc('reinstate_member', { p_profile: gone.id, p_reason: 'e2e: not allowed' })
  expect(refused.error?.message).toBe('not allowed')
  const still = await admin().from('profiles').select('status').eq('id', gone.id).single()
  expect(still.data?.status).toBe('removed')

  const asBoss = await asUser(boss.email, boss.password)
  const active = await asBoss.rpc('reinstate_member', { p_profile: live.id, p_reason: 'e2e: not removed' })
  expect(active.error?.message).toBe('not_reinstatable')
  const short = await asBoss.rpc('reinstate_member', { p_profile: gone.id, p_reason: 'ab' })
  expect(short.error?.message).toBe('invalid_reason')
})
