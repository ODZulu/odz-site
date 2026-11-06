import { expect, test, type Browser, type Page } from '@playwright/test'
import { asUser, cleanup, hasBackend, resetInviteAttempts, seedUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

async function signInPage(browser: Browser, u: { email: string; password: string }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
  return page
}

const article = (page: Page, title: string) => page.locator('article.odz-event').filter({ hasText: title })

test('Command drops a pin, edits it, removes it; a Member sees it; the public API never does', async ({ browser }) => {
  const cmd = await seedUser('command', 'crd-cmd')
  const mem = await seedUser('member', 'crd-mem')
  const title = 'E2E Pinned Event'

  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  await cp.getByRole('button', { name: 'New event' }).click()
  await cp.getByLabel('Title', { exact: true }).fill(title)
  await cp.getByLabel('Starts (Phoenix time)').fill('2030-05-04T09:00')
  await cp.getByLabel('Latitude').fill('95')
  await cp.getByLabel('Longitude').fill('10')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(cp.getByText('Latitude must be between -90 and 90.')).toBeVisible()
  await cp.getByLabel('Latitude').fill('33.4484')
  await cp.getByLabel('Longitude').fill('-112.074')
  expect(await cp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(article(cp, title).getByText('Pin 33.4484, -112.074')).toBeVisible()
  await expect(article(cp, title).getByRole('link', { name: 'Open in maps app' })).toHaveAttribute('href', /^geo:33\.4484,-112\.074/)

  // A Member with event details sees the pin.
  const mp = await signInPage(browser, mem)
  await mp.goto('/calendar')
  await expect(article(mp, title).getByText('Pin 33.4484, -112.074')).toBeVisible()

  // The public API shows the event but never its coordinates.
  const anon = await asUser()
  const pub = await anon.from('events').select('id,title').eq('title', title)
  expect(pub.data).toHaveLength(1)
  expect((await anon.from('event_details').select('latitude,longitude')).error).not.toBeNull()

  // Remove the pin.
  await article(cp, title).getByRole('button', { name: 'Edit' }).click()
  await expect(cp.getByLabel('Latitude')).toHaveValue('33.4484')
  await cp.getByRole('button', { name: 'Remove pin' }).click()
  await expect(cp.getByLabel('Latitude')).toHaveValue('')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(article(cp, title)).toBeVisible()
  await expect(article(cp, title).getByText(/^Pin /)).toHaveCount(0)
})

test('Command records a past mission as completed; it shows no RSVP', async ({ browser }) => {
  const cmd = await seedUser('command', 'crd-bf')
  const title = 'E2E Road to Fake Rostov'
  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  await cp.getByRole('button', { name: 'New event' }).click()
  await cp.getByLabel('Title', { exact: true }).fill(title)
  await cp.getByLabel('Starts (Phoenix time)').fill('2015-06-01T09:00')
  await cp.getByLabel('Latitude').fill('55.7558')
  await cp.getByLabel('Longitude').fill('37.6173')
  await cp.getByLabel('Past mission: record as completed').check()
  await cp.getByRole('button', { name: 'Save event' }).click()
  await cp.getByText(/Past events/).click()
  const a = article(cp, title)
  await expect(a).toBeVisible()
  await expect(a.getByText('COMPLETED')).toBeVisible()
  await expect(a.getByText('RSVP and readiness')).toHaveCount(0)
  await expect(a.getByText('Pin 55.7558, 37.6173')).toBeVisible()

  // A future date cannot be marked completed.
  await cp.getByRole('button', { name: 'New event' }).click()
  await cp.getByLabel('Title', { exact: true }).fill('E2E Not Yet Done')
  await cp.getByLabel('Starts (Phoenix time)').fill('2099-01-01T09:00')
  await cp.getByLabel('Past mission: record as completed').check()
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(cp.getByText('A completed event must have started already.')).toBeVisible()
})
