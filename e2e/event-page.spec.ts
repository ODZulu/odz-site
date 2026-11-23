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
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0)
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

test('Admin edits from the event page on its own edit page, and cancels', async ({ page }) => {
  const ev = await createEventRow({ location: SECRET_LOCATION })
  await signIn(page, await seedUser('admin', 'evp-adm'))
  await page.goto(`/events/${ev.id}`)
  await page.getByRole('link', { name: 'Edit' }).click()
  // Its own page: heading first, focus in the form.
  await expect(page).toHaveURL(new RegExp(`/events/${ev.id}/edit$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Edit event' })).toBeVisible()
  await expect(page.getByLabel('Title')).toBeFocused()
  await page.getByLabel('Title').fill(`${ev.title} renamed`)
  await page.getByRole('button', { name: 'Save event' }).click()
  // Save returns to the event page.
  await expect(page).toHaveURL(new RegExp(`/events/${ev.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: `${ev.title} renamed` })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel event' }).click()
  await page.getByRole('button', { name: 'Confirm cancel' }).click()
  await expect(page.getByText('CANCELLED', { exact: true })).toBeVisible()
})

test('Close on the edit page returns to the event page, with nothing saved', async ({ page }) => {
  const ev = await createEventRow()
  await signIn(page, await seedUser('admin', 'evp-close'))
  await page.goto(`/events/${ev.id}`)
  await page.getByRole('link', { name: 'Edit' }).click()
  await page.getByLabel('Title').fill('E2E not saved')
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${ev.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: ev.title })).toBeVisible()
})

test('Duplicate opens its own page with the times cleared and saves a new event', async ({ page }) => {
  const ev = await createEventRow()
  await signIn(page, await seedUser('admin', 'evp-dup'))
  await page.goto(`/events/${ev.id}`)
  await page.getByRole('link', { name: 'Duplicate' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${ev.id}/duplicate$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Duplicate event' })).toBeVisible()
  await expect(page.getByLabel('Starts (Phoenix time)')).toHaveValue('')
  await page.getByLabel('Starts (Phoenix time)').fill('2030-02-15T06:30')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/)
  await expect(page).not.toHaveURL(new RegExp(ev.id))
  await expect(page.getByRole('heading', { level: 1, name: ev.title })).toBeVisible()
})

test('a Member sent to the edit URL lands on the event page, with no form', async ({ page }) => {
  const ev = await createEventRow()
  await signIn(page, await seedUser('member', 'evp-noedit'))
  await page.goto(`/events/${ev.id}/edit`)
  await expect(page).toHaveURL(new RegExp(`/events/${ev.id}$`))
  await expect(page.getByLabel('Title')).toHaveCount(0)
})

test('a signed-out visitor sent to the edit URL ends up at login for a member event', async ({ page }) => {
  const ev = await createEventRow()
  await admin().from('events').update({ audience: 'members' }).eq('id', ev.id)
  await page.goto(`/events/${ev.id}/edit`)
  await expect(page).toHaveURL(/\/login$/)
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
