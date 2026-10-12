import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await admin().from('traffic').delete().like('title', 'E2E %')
  await cleanup()
})

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

test('every HQ panel has an empty state on a fresh stack, and public pages show none of it', async ({ page, request }) => {
  await signIn(page, await seedUser('member', 'hq-empty'))
  await expect(page.getByRole('heading', { name: 'Tier breakdown' })).toBeVisible()
  await expect(page.getByText('Nothing scheduled.').first()).toBeVisible()
  await expect(page.getByText('No traffic.')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.goto('/')
  await expect(page.locator('body')).not.toContainText('Tier breakdown')
  const anonTraffic = await request.get(`${process.env.E2E_SUPABASE_URL}/rest/v1/traffic?select=id`, {
    headers: { apikey: process.env.E2E_SUPABASE_ANON_KEY as string },
  })
  expect(anonTraffic.ok()).toBe(false)
})

test('Command posts traffic; a Member sees it, pinned first, and cannot post', async ({ page, browser }) => {
  const cmd = await seedUser('command', 'hq-cmd')
  const mem = await seedUser('member', 'hq-mem')

  await signIn(page, cmd)
  await page.goto('/traffic')
  await page.getByLabel('Title').fill('E2E Plain notice')
  await page.getByLabel('Message').fill('Fake message one')
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  // The form clears when the first post lands; wait for it so the next fill is not wiped.
  await expect(page.getByText('E2E Plain notice')).toBeVisible()
  await page.getByLabel('Title').fill('E2E Pinned notice')
  await page.getByLabel('Message').fill('<b>Fake</b> message two')
  await page.getByLabel('Pin to the top').check()
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(page.getByText('E2E Pinned notice')).toBeVisible()

  const ctx = await browser.newContext()
  const memberPage = await ctx.newPage()
  await signIn(memberPage, mem)
  const titles = await memberPage.locator('.odz-post__title').allInnerTexts()
  expect(titles.slice(0, 2)).toEqual(['E2E Pinned notice', 'E2E Plain notice'])
  await expect(memberPage.getByText('<b>Fake</b> message two')).toBeVisible() // text, not markup
  await memberPage.goto('/traffic')
  await expect(memberPage.getByRole('button', { name: 'Post', exact: true })).toHaveCount(0)

  // Archive: gone for members.
  const card = page.locator('article', { hasText: 'E2E Plain notice' })
  await card.getByRole('button', { name: 'Archive' }).click()
  await card.getByRole('button', { name: 'Confirm archive' }).click()
  await memberPage.reload()
  await expect(memberPage.getByText('E2E Plain notice')).toHaveCount(0)
  await ctx.close()
})

test('RSVP: members answer, readiness counts follow, and a past event is closed', async ({ page }) => {
  const mem = await seedUser('member', 'hq-rsvp')
  const upcoming = await createEventRow({ title: 'E2E RSVP Event', inDays: 2 })
  const past = await createEventRow({ title: 'E2E Past Event', inDays: -2 })
  void past
  await signIn(page, mem)
  await page.goto('/calendar')

  const card = page.locator('article', { hasText: upcoming.title })
  await card.getByText('RSVP and readiness').click()
  await card.getByRole('button', { name: 'IN', exact: true }).click()
  await expect(card.getByRole('button', { name: 'IN', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(card.getByText(/1 \/ \d+ IN/)).toBeVisible()
  await expect(card.getByText(mem.callsign)).toBeVisible()
  await card.getByRole('button', { name: 'OUT', exact: true }).click()
  await expect(card.getByRole('button', { name: 'OUT', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.getByText(/Past events/).click()
  const pastCard = page.locator('article', { hasText: 'E2E Past Event' })
  await pastCard.getByText('RSVP and readiness').click()
  await expect(pastCard.getByRole('button', { name: 'IN', exact: true })).toBeDisabled()
})
