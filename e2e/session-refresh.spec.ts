import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, openSeatCaps, resetInviteAttempts, seedUser, tierId } from './helpers/backend'

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

// What a returning tab does: the window regains focus. The refresh collapses focus events that
// arrive within 3 seconds of the last read, so wait that out first.
const refocus = async (page: Page) => {
  await page.waitForTimeout(3500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

test('MVA-252: an open session follows a role change without signing out', async ({ page }) => {
  await openSeatCaps()
  const u = await seedUser('member', 'sr-mem')
  await signIn(page, u)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'MOTIONS' })).toHaveCount(0)

  // Promoted elsewhere (Old Guard sees Motions and Designations): the open session catches up on the next refresh.
  expect((await admin().from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', u.id)).error).toBeNull()
  await refocus(page)
  await expect(nav.getByRole('link', { name: 'MOTIONS' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'DESIGNATIONS' })).toBeVisible()

  // Demoted again: the tabs go, still no sign-out.
  expect((await admin().from('profiles').update({ tier_id: await tierId('Member') }).eq('id', u.id)).error).toBeNull()
  await refocus(page)
  await expect(nav.getByRole('link', { name: 'MOTIONS' })).toHaveCount(0)
  await expect(page).toHaveURL(/\/hq$/)
})

test('MVA-252: a retired member lands on the Retired home; a removed member is signed out', async ({ page }) => {
  const retiredUser = await seedUser('member', 'sr-ret')
  await signIn(page, retiredUser)
  expect((await admin().from('profiles').update({ status: 'retired' }).eq('id', retiredUser.id)).error).toBeNull()
  await refocus(page)
  await expect(page).toHaveURL(/\/retired$/)

  const boss = await seedUser('admin', 'sr-boss')
  const gone = await seedUser('member', 'sr-rem')
  await page.context().clearCookies()
  await page.evaluate(() => localStorage.clear())
  await signIn(page, gone)
  expect((await (await asUser(boss.email, boss.password)).rpc('remove_member', { p_profile: gone.id, p_reason: 'e2e: session refresh' })).error).toBeNull()
  await refocus(page)
  await expect(page).toHaveURL(/\/login$/)
})
