import { expect, test, type Page } from '@playwright/test'
import { cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

// Fake, member-only detail (MVA-300). It must never be on screen once the user is signed out.
const WHERE = 'E2E Fake Field'
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function signOutFrom(page: Page, path: string) {
  await page.goto(path)
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(WHERE)
  expect(await noSideScroll(page)).toBe(true)
}

test('signing out from HQ, the calendar and a profile page lands on the login page with no member data', async ({ page }) => {
  const member = await seedUser('member', 'out-mem')
  const ev = await createEventRow({ title: 'E2E Fake Logout Event', location: WHERE, detail: 'E2E Fake gate note', inDays: 3 })

  // MVA-301: the location is on the event page now, not on the calendar card, so the event page is a path too.
  for (const path of ['/hq', '/calendar', '/me', `/events/${ev.id}`]) {
    await signIn(page, member)
    if (path.startsWith('/events/')) {
      await page.goto(path)
      await expect(page.getByText(WHERE).first()).toBeVisible() // member data is on screen before signing out
    }
    await signOutFrom(page, path)
  }
})

test('after signing out, Back does not show member pages or data', async ({ page }) => {
  const member = await seedUser('member', 'out-back')
  const where = 'E2E Fake Back Field' // its own text: the other tests' events are still in the database
  const ev = await createEventRow({ title: 'E2E Fake Back Event', location: where, inDays: 3 })
  await signIn(page, member)
  await page.goto(`/events/${ev.id}`) // MVA-301: the location is shown on the event page
  await expect(page.getByText(where)).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)

  for (let i = 0; i < 3; i++) {
    await page.goBack().catch(() => undefined)
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('body')).not.toContainText(where)
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  }
})

test('a signed-out visitor is sent to login from a member URL; public pages are unchanged', async ({ page }) => {
  await createEventRow({ title: 'E2E Fake Public Event', location: WHERE, inDays: 3 })
  for (const path of ['/hq', '/roster', '/me', '/motions']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
  }
  // The public calendar stays on its own URL and shows the event but none of the member-only detail.
  await page.goto('/calendar')
  await expect(page).toHaveURL(/\/calendar$/)
  await expect(page.getByRole('heading', { name: 'E2E Fake Public Event' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(WHERE)
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
})
