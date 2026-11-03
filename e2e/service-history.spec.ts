import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, hasBackend, resetInviteAttempts, seedUser, tierId } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
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

test('Command sets DOE and adds, edits and deletes entries without leaving the page', async ({ page }) => {
  const cmd = await seedUser('command', 'svc-cmd')
  const target = await seedUser('member', 'svc-target')
  await signIn(page, cmd)
  await memberPage(page, target)

  await page.getByLabel('DOE').fill('2014-11-10')
  await page.getByRole('button', { name: 'Save DOE' }).click()
  await expect(page.getByText('2014')).toBeVisible()
  await expect(page.getByText(/year.*of service/)).toBeVisible()

  // Bulk-friendly: add a second entry without navigating away.
  await page.getByLabel('Date', { exact: true }).fill('2015-06-01')
  await page.getByLabel('Mission or event name').fill('Road to Rostov')
  await page.getByRole('button', { name: 'Add entry' }).click()
  await expect(page.getByText('Road to Rostov')).toBeVisible()

  await page.getByLabel('Date', { exact: true }).fill('2016-03-01')
  await page.getByLabel('Mission or event name').fill('Second op')
  await page.getByRole('button', { name: 'Add entry' }).click()
  await expect(page.getByText('Second op')).toBeVisible()
  await expect(page.getByText('2 missions')).toBeVisible()

  // Edit a specific entry by its text, not position: entries sort most-recent-first, so "Second
  // op" (2016) renders before "Road to Rostov" (2015).
  await page.locator('li').filter({ hasText: 'Road to Rostov' }).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Mission or event name').fill('Road to Rostov (corrected)')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Road to Rostov (corrected)')).toBeVisible()

  // Delete it; one mission remains.
  await page.locator('li').filter({ hasText: 'Road to Rostov (corrected)' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('1 mission')).toBeVisible()

  const row = await admin().from('service_history').select('title').eq('profile_id', target.id)
  expect(row.data).toEqual([{ title: 'Second op' }])
})

test("a plain Member sees their own record read-only, and cannot see someone else's", async ({ page }) => {
  const cmd = await seedUser('command', 'svc-ro-cmd')
  const mem = await seedUser('member', 'svc-ro-mem')
  const other = await seedUser('member', 'svc-ro-other')
  await signIn(page, cmd)
  await memberPage(page, mem)
  await page.getByLabel('DOE').fill('2018-01-01')
  await page.getByRole('button', { name: 'Save DOE' }).click()
  await expect(page.getByText('2018')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

  await signIn(page, mem)
  await memberPage(page, mem)
  await expect(page.getByText('2018')).toBeVisible()
  await expect(page.getByLabel('DOE')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add entry' })).toHaveCount(0)

  await memberPage(page, other)
  await expect(page.getByText('Service record')).toHaveCount(0)
})

test('Old Guard (a seat holder with no edit_roster) can compare seniority on the roster but cannot edit it', async ({ page }) => {
  const cmd = await seedUser('command', 'svc-seat-cmd')
  const og = await seedUser('member', 'svc-seat-og')
  const target = await seedUser('member', 'svc-seat-target')
  const ogId = await tierId('Old Guard')
  expect((await admin().from('profiles').update({ tier_id: ogId }).eq('id', og.id)).error).toBeNull()

  await signIn(page, cmd)
  await memberPage(page, target)
  await page.getByLabel('DOE').fill('2016-05-01')
  await page.getByRole('button', { name: 'Save DOE' }).click()
  await expect(page.getByText('2016')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

  await signIn(page, og)
  await page.goto('/roster')
  // Not toBeVisible(): the table header is visually clipped (screen-reader-only) below 720px.
  await expect(page.getByText('Seniority')).toBeAttached()
  await memberPage(page, target)
  await expect(page.getByLabel('DOE')).toHaveCount(0)
})
