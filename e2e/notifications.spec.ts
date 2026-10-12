import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await admin().from('notifications').delete().like('title', 'E2E %')
  await cleanup()
})

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

test('a new event notifies members with event access, not a Recruit, and carries no location', async ({ page, browser }) => {
  const mem = await seedUser('member', 'ntf-mem')
  const rec = await seedUser('recruit', 'ntf-rec')
  const ev = await createEventRow({ title: 'E2E Notify Event', location: 'E2E-SECRET-PLACE', detail: 'E2E-SECRET-DIRECTIONS' })

  await signIn(page, mem)
  await expect(page.getByRole('link', { name: /Notifications, \d+ unread/ })).toBeVisible()
  await page.goto('/notifications')
  await expect(page.getByText(ev.title)).toBeVisible()
  await expect(page.getByText('NEW EVENT')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('E2E-SECRET')

  await page.getByRole('button', { name: 'Open' }).first().click()
  await expect(page).toHaveURL(/\/calendar$/)
  await page.goto('/notifications')
  await expect(page.getByText('NEW', { exact: true })).toHaveCount(0)

  const ctx = await browser.newContext()
  const recPage = await ctx.newPage()
  await signIn(recPage, rec)
  await recPage.goto('/notifications')
  await expect(recPage.getByText(ev.title)).toHaveCount(0)
  await ctx.close()
})

test('the test notification appears at once and is rate limited', async ({ page }) => {
  await signIn(page, await seedUser('member', 'ntf-test'))
  await page.goto('/settings/notifications')
  await page.getByRole('button', { name: 'Send test notification' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Test sent' })).toBeVisible()
  await page.getByRole('button', { name: 'Send test notification' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Wait a minute' })).toBeVisible()
  await page.goto('/notifications')
  await expect(page.getByText('Test notification')).toBeVisible()
})

test('lead times can be changed but never emptied', async ({ page }) => {
  await signIn(page, await seedUser('member', 'ntf-lead'))
  await page.goto('/settings/notifications')
  await page.getByLabel('30 minutes before').click()
  await expect(page.getByLabel('30 minutes before')).toBeChecked()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  // Each toggle saves on the server; the last one is refused, so the box stays checked (click, not uncheck()).
  await page.getByLabel('24 hours before', { exact: true }).click()
  await expect(page.getByLabel('24 hours before', { exact: true })).not.toBeChecked()
  await page.getByLabel('2 hours before', { exact: true }).click()
  await expect(page.getByLabel('2 hours before', { exact: true })).not.toBeChecked()
  await page.getByLabel('30 minutes before', { exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'at least one' })).toBeVisible()
  await expect(page.getByLabel('30 minutes before')).toBeChecked()
})
