import { expect, test, type Page } from '@playwright/test'
import { cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

// MVA-297 PR B: the app shell at two fixed sizes. Layout does not depend on the device, so these
// run once, in the desktop project, with their own viewports.
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'the shell tests set their own viewport')
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

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false })

  test('sidebar, breadcrumb, bell and one sign-out; the nav lists only routes that exist', async ({ page }) => {
    const mem = await seedUser('member', 'shell-d')
    await signIn(page, mem)

    const nav = page.getByRole('navigation', { name: 'Main' })
    const side = page.getByRole('complementary')
    await expect(side).toBeVisible()
    await expect(side.getByRole('link', { name: 'ODZ home' })).toBeVisible()
    for (const label of ['HQ', 'ROSTER', 'CALENDAR']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible()
    for (const label of ['RESOURCES', 'MISSIONS', 'ATLAS', 'AAR', 'QUARTERMASTER']) await expect(nav.getByRole('link', { name: label })).toHaveCount(0)
    // The nav sits inside the sidebar, not along the bottom.
    const box = (await nav.boundingBox())!
    expect(box.x).toBeLessThan(260)
    expect(box.y + box.height).toBeLessThan(800)

    // The user card holds the callsign link, the tier and the one sign-out.
    await expect(side.getByRole('link', { name: 'My profile', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(1)
    await expect(side.getByRole('button', { name: 'Sign out' })).toBeVisible()

    // Top bar: breadcrumb names the page, bell and profile button are there.
    await page.getByRole('link', { name: 'CALENDAR', exact: true }).click()
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Calendar')
    await expect(page.getByRole('link', { name: /^Notifications/ })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Profile', exact: true })).toBeVisible()
    expect(await noSideScroll(page)).toBe(true)
  })

  test('the focus ring shows on a nav link, and the bell badge shows the real unread count', async ({ page }) => {
    const mem = await seedUser('member', 'shell-b')
    await createEventRow({ title: 'E2E Shell Event' })
    await signIn(page, mem)

    const bell = page.getByRole('link', { name: /Notifications, \d+ unread/ })
    await expect(bell).toBeVisible()
    const n = /(\d+) unread/.exec((await bell.getAttribute('aria-label')) ?? '')![1]
    await expect(bell.locator('.odz-badge')).toHaveText(n)

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link').first().focus()
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement as Element)
      return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }
    })
    expect(ring).toEqual({ style: 'solid', width: '2px', offset: '3px' })
  })
})

test.describe('360px', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true })

  test('bottom tab bar with icons, 44px targets, no sideways scroll, sign-out in the top bar', async ({ page }) => {
    const mem = await seedUser('member', 'shell-m')
    await signIn(page, mem)

    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0)
    const box = (await nav.boundingBox())!
    expect(Math.round(box.y + box.height)).toBe(740)
    for (const label of ['HQ', 'ROSTER', 'CALENDAR']) {
      const link = nav.getByRole('link', { name: label, exact: true })
      await expect(link).toBeVisible()
      await expect(link.locator('svg')).toHaveCount(1)
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'ODZ home' })).toHaveCount(1)
    expect(await noSideScroll(page)).toBe(true)
  })
})
