import { expect, test, type Page } from '@playwright/test'
import { cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

const SECRET_LOCATION = 'E2E-SECRET-LOCATION'
const SECRET_DETAIL = 'E2E-SECRET-DIRECTIONS'
const SECRET_DESCRIPTION = 'E2E-SECRET-DESCRIPTION'

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

test('anonymous visitors get titles and times, and no location or description over the network', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION, detail: SECRET_DETAIL, description: SECRET_DESCRIPTION })
  const bodies: string[] = []
  const urls: string[] = []
  page.on('response', async (r) => {
    if (r.url().includes('/rest/v1/')) {
      urls.push(r.url())
      bodies.push(await r.text().catch(() => ''))
    }
  })
  await page.goto('/calendar')
  await expect(page.getByText(ev.title)).toBeVisible()
  expect(urls.some((u) => u.includes('/rest/v1/public_events'))).toBe(true)
  expect(urls.some((u) => /\/rest\/v1\/events\b/.test(u))).toBe(false)
  const all = bodies.join('\n') + (await page.locator('body').innerText())
  for (const secret of [SECRET_LOCATION, SECRET_DETAIL, SECRET_DESCRIPTION]) expect(all).not.toContain(secret)
})

test('a Recruit sees the listing but not the details', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION, detail: SECRET_DETAIL })
  await signIn(page, await seedUser('recruit', 'cal-rec'))
  await page.goto('/calendar')
  await expect(page.getByText(ev.title)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET_LOCATION)
  await expect(page.getByText('Details', { exact: true })).toHaveCount(0)
})

test('a Member sees location, directions and description', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION, detail: SECRET_DETAIL, description: '**' + SECRET_DESCRIPTION + '**' })
  await signIn(page, await seedUser('member', 'cal-mem'))
  await page.goto('/calendar')
  await expect(page.getByText(ev.title)).toBeVisible()
  await expect(page.getByText(SECRET_LOCATION)).toBeVisible()
  await page.getByText('Details', { exact: true }).first().click()
  await expect(page.getByText(SECRET_DETAIL)).toBeVisible()
  await expect(page.getByText(SECRET_DESCRIPTION)).toBeVisible()
  await expect(page.getByRole('button', { name: 'New event' })).toHaveCount(0)
})

test('a script in an event description renders inert', async ({ page }) => {
  await createEventRow({ detail: 'x', description: '<script>window.__pwned = 1</script>hello' })
  await signIn(page, await seedUser('member', 'cal-xss'))
  await page.goto('/calendar')
  await page.getByText('Details', { exact: true }).first().click()
  await expect(page.locator('.odz-md')).toContainText('<script>')
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
})

test('Command creates, edits and cancels an event', async ({ page }) => {
  await signIn(page, await seedUser('command', 'cal-cmd'))
  await page.goto('/calendar')
  await page.getByRole('button', { name: 'New event' }).click()

  // Validation: the end must be after the start.
  await page.getByLabel('Title').fill('E2E Range Day')
  await page.getByLabel('Starts (Phoenix time)').fill('2030-01-15T06:30')
  await page.getByLabel('Ends (optional)').fill('2030-01-15T05:00')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('The end must be after the start.')).toBeVisible()

  await page.getByLabel('Ends (optional)').fill('2030-01-15T10:00')
  await page.getByLabel('Location name').fill('E2E Fake Range')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('E2E Range Day')).toBeVisible()
  await expect(page.getByText('0630L-1000L')).toBeVisible()

  const card = page.locator('article', { hasText: 'E2E Range Day' })
  await card.getByRole('button', { name: 'Cancel event' }).click()
  await card.getByRole('button', { name: 'Confirm cancel' }).click()
  await expect(card.getByText('CANCELLED')).toBeVisible()
})
