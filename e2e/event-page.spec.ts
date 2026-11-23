import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

// MVA-301 PR 1: each event has its own page at /events/:id, with the sections the calendar card held.
test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

const SECRET_LOCATION = 'E2E-PAGE-LOCATION'
const SECRET_DETAIL = 'E2E-PAGE-DIRECTIONS'
const SECRET_DESCRIPTION = 'E2E-PAGE-DESCRIPTION'

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

test('a Member opens the event page directly and sees the sections in order', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION, detail: SECRET_DETAIL, description: SECRET_DESCRIPTION })
  await signIn(page, await seedUser('member', 'evp-mem'))
  await page.goto(`/events/${ev.id}`)
  await expect(page.getByRole('heading', { level: 1, name: ev.title })).toBeVisible()
  await expect(page.getByText(SECRET_LOCATION)).toBeVisible()
  await expect(page.getByText(SECRET_DETAIL)).toBeVisible()
  await expect(page.getByText(SECRET_DESCRIPTION)).toBeVisible()
  const headings = await page.getByRole('heading', { level: 2 }).allInnerTexts()
  const order = ['When and where', 'Details', 'Registration'].map((h) => headings.findIndex((x) => x.toLowerCase() === h.toLowerCase()))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
})

test('a signed-out visitor is sent to login for a member event', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION })
  // Restrict the event to members; the fixture is public by default.
  await admin().from('events').update({ audience: 'members' }).eq('id', ev.id)
  await page.goto(`/events/${ev.id}`)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('body')).not.toContainText(SECRET_LOCATION)
})

test('a signed-out visitor sees a public event with no details', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION, detail: SECRET_DETAIL, description: SECRET_DESCRIPTION })
  await page.goto(`/events/${ev.id}`)
  await expect(page.getByRole('heading', { level: 1, name: ev.title })).toBeVisible()
  const all = await page.locator('body').innerText()
  for (const secret of [SECRET_LOCATION, SECRET_DETAIL, SECRET_DESCRIPTION]) expect(all).not.toContain(secret)
})

test('an unknown event id says not found', async ({ page }) => {
  await signIn(page, await seedUser('member', 'evp-404'))
  await page.goto('/events/00000000-0000-0000-0000-000000000000')
  await expect(page.getByRole('heading', { name: 'Event not found' })).toBeVisible()
})

test('Admin edits and cancels from the page', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION })
  await signIn(page, await seedUser('admin', 'evp-adm'))
  await page.goto(`/events/${ev.id}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Title').fill(`${ev.title} renamed`)
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByRole('heading', { level: 1, name: `${ev.title} renamed` })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel event' }).click()
  await page.getByRole('button', { name: 'Confirm cancel' }).click()
  await expect(page.getByText('CANCELLED')).toBeVisible()
})

test('a past event shows no register or withdraw controls', async ({ page }) => {
  const ev = await createEventRow({ inDays: -2 })
  await signIn(page, await seedUser('member', 'evp-past'))
  await page.goto(`/events/${ev.id}`)
  await expect(page.getByRole('heading', { level: 1, name: ev.title })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Register|Join the waitlist|Withdraw|Request withdrawal)$/ })).toHaveCount(0)
})

test('fits at 360px without sideways scroll', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION, description: SECRET_DESCRIPTION })
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page, await seedUser('member', 'evp-360'))
  await page.goto(`/events/${ev.id}`)
  await expect(page.getByRole('heading', { level: 1, name: ev.title })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
