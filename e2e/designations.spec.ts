import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, tierId } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
// Assignments are not scoped to a single test's users (the holder cap is global), so each test
// starts from zero current holders rather than depending on what an earlier test revoked.
test.afterEach(async () => {
  await admin().from('member_designations').delete().not('profile_id', 'is', null)
})
test.afterAll(async () => {
  await cleanup()
})

async function signIn(page: Page, u: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

const memberPage = (page: Page, u: { callsign: string }) => page.goto(`/roster/${encodeURIComponent(u.callsign)}`)

test('Command assigns two designations to an Old Guard member, the roster shows them, Command revokes one', async ({ page }) => {
  const cmd = await seedUser('command', 'des-cmd')
  const target = await seedUser('member', 'des-target')
  const ogId = await tierId('Old Guard')
  expect((await admin().from('profiles').update({ tier_id: ogId }).eq('id', target.id)).error).toBeNull()

  await signIn(page, cmd)
  await memberPage(page, target)

  await page.getByLabel('Assign a designation', { exact: false }).selectOption({ label: 'Treasurer' })
  await page.getByRole('button', { name: 'Assign' }).click()
  await expect(page.getByText('Treasurer', { exact: true })).toBeVisible()

  await page.getByLabel('Assign a designation', { exact: false }).selectOption({ label: 'Quartermaster' })
  await page.getByRole('button', { name: 'Assign' }).click()
  await expect(page.getByText('Quartermaster', { exact: true })).toBeVisible()

  // Badges show on the roster too. A plain tag locator, not getByRole('row'): the responsive
  // table CSS switches <tr> to display:flex below 720px, which drops its implicit row role.
  await page.goto('/roster')
  const row = page.locator('tr').filter({ hasText: target.callsign })
  await expect(row.getByText('Treasurer', { exact: true })).toBeVisible()
  await expect(row.getByText('Quartermaster', { exact: true })).toBeVisible()

  // Revoking one leaves the other. Held badges render in catalog (alphabetical) order, so the
  // first Revoke button is Quartermaster's, not Treasurer's; the revoked one also reappears in
  // the assign picker's options, so check the remaining Revoke button count, not the page text.
  await memberPage(page, target)
  await page.getByRole('button', { name: 'Revoke' }).first().click()
  await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(1)
  await expect(page.getByText('Treasurer', { exact: true })).toBeVisible()

  const rows = await admin().from('member_designations').select('designation_id').eq('profile_id', target.id)
  expect(rows.data).toHaveLength(1)
})

test('an office seat cannot go to a Member, and the holder cap is enforced with a clear message', async ({ page }) => {
  const cmd = await seedUser('command', 'des-elig-cmd')
  const mem = await seedUser('member', 'des-elig-mem')
  const og1 = await seedUser('member', 'des-elig-og1')
  const og2 = await seedUser('member', 'des-elig-og2')
  const ogId = await tierId('Old Guard')
  for (const u of [og1, og2]) {
    expect((await admin().from('profiles').update({ tier_id: ogId }).eq('id', u.id)).error).toBeNull()
  }

  await signIn(page, cmd)
  await memberPage(page, mem)
  await page.getByLabel('Assign a designation', { exact: false }).selectOption({ label: 'Treasurer' })
  await page.getByRole('button', { name: 'Assign' }).click()
  await expect(page.getByRole('alert')).toContainText('Command and Old Guard')

  await memberPage(page, og1)
  await page.getByLabel('Assign a designation', { exact: false }).selectOption({ label: 'Treasurer' })
  await page.getByRole('button', { name: 'Assign' }).click()
  await expect(page.getByText('Treasurer', { exact: true })).toBeVisible()

  await memberPage(page, og2)
  await page.getByLabel('Assign a designation', { exact: false }).selectOption({ label: 'Treasurer' })
  await page.getByRole('button', { name: 'Assign' }).click()
  await expect(page.getByRole('alert')).toContainText('maximum number of holders')
})

test('the Vacant list is visible to Old Guard, hidden from a plain Member, and Command inherits every designation capability unassigned', async ({ page }) => {
  const mem = await seedUser('member', 'des-vacant-mem')
  const og = await seedUser('member', 'des-vacant-og')
  const cmd = await seedUser('command', 'des-vacant-cmd')
  const ogId = await tierId('Old Guard')
  expect((await admin().from('profiles').update({ tier_id: ogId }).eq('id', og.id)).error).toBeNull()

  await signIn(page, mem)
  await expect(page.getByRole('link', { name: 'DESIGNATIONS' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

  await signIn(page, og)
  await page.goto('/designations')
  await expect(page.getByRole('cell', { name: 'Vacant' }).first()).toBeVisible()

  const asCmd = await asUser(cmd.email, cmd.password)
  const caps = await asCmd.rpc('my_capabilities')
  expect(caps.data).toEqual(expect.arrayContaining(['manage_treasury', 'manage_inventory', 'manage_shop', 'hold_office_xo', 'hold_office_training']))
})
