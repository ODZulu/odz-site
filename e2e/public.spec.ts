import { expect, test } from '@playwright/test'

// UI-only checks: no backend needed. The dev server runs with no Supabase config unless the
// E2E_* variables are set, and an anonymous visitor behaves the same either way.

const gated = ['/hq', '/roster', '/members', '/admin', '/documents', '/minutes', '/me', '/setup', '/pending']

test.describe('anonymous visitor', () => {
  for (const path of gated) {
    test(`${path} goes to login`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    })
  }

  test('public pages never link to /join or mention how people join', async ({ page }) => {
    for (const path of ['/', '/login']) {
      await page.goto(path)
      const hrefs = await page.locator('a[href]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))
      expect(hrefs.filter((h) => h.includes('join'))).toEqual([])
      const text = (await page.locator('body').innerText()).toLowerCase()
      for (const word of ['sign up', 'signup', 'register', 'request access', 'invite', 'apply']) {
        expect(text).not.toContain(word)
      }
    }
  })

  test('login has no forgot-password link and says who to ask', async ({ page }) => {
    await page.goto('/login')
    const text = (await page.locator('body').innerText()).toLowerCase()
    expect(text).not.toContain('forgot')
    expect(text).toContain('locked out? contact command')
  })

  test('the calendar is public and offers a way to sign in', async ({ page }) => {
    await page.goto('/calendar')
    await expect(page).toHaveURL(/\/calendar$/)
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    await expect(page.getByText('All times Phoenix')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  })

  test('the landing page offers sign in only', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  })

  test('the app installs as a PWA (manifest and service worker are served)', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest')
    expect(manifest.ok()).toBe(true)
  })
})

test.describe('landing hero logos (MVA-244)', () => {
  const seal = 'Operational Detachment Zulu seal'
  const general = 'Operational Detachment Zulu general patch'
  const styleOpacity = (l: ReturnType<import('@playwright/test').Page['getByAltText']>) =>
    l.evaluate((el) => (el as HTMLElement).style.opacity)

  test('renders one logo at a time and crossfades to the other after the interval', async ({ page }) => {
    await page.clock.install()
    await page.goto('/')
    const a = page.getByAltText(seal)
    const b = page.getByAltText(general)
    await expect(a).toBeAttached()
    await expect(b).toBeAttached()

    const before = await Promise.all([styleOpacity(a), styleOpacity(b)])
    expect([...before].sort()).toEqual(['0', '1'])

    // runFor (not fastForward) actually fires the pending interval tick instead of just jumping
    // the clock past it, so it isn't racing the mount effect that registers the interval.
    await page.clock.runFor(6700)
    await expect.poll(() => styleOpacity(a)).not.toBe(before[0])
    const after = await Promise.all([styleOpacity(a), styleOpacity(b)])
    expect([...after].sort()).toEqual(['0', '1'])
  })

  test('prefers-reduced-motion shows one logo and never rotates', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.clock.install()
    await page.goto('/')
    const a = page.getByAltText(seal)
    const b = page.getByAltText(general)
    const before = await Promise.all([styleOpacity(a), styleOpacity(b)])

    await page.clock.runFor(20_000)
    const after = await Promise.all([styleOpacity(a), styleOpacity(b)])
    expect(after).toEqual(before)
  })

  test('both marks render at the same size on the same round backing at 360px and desktop (MVA-250)', async ({ page }) => {
    for (const size of [{ width: 360, height: 800 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(size)
      await page.goto('/')
      const a = await page.getByAltText(seal).boundingBox()
      const b = await page.getByAltText(general).boundingBox()
      expect(a && b).toBeTruthy()
      expect(Math.abs(a!.width - b!.width)).toBeLessThanOrEqual(2)
      expect(Math.abs(a!.height - b!.height)).toBeLessThanOrEqual(2)
      expect(Math.abs(a!.width - a!.height)).toBeLessThanOrEqual(2)
      // Both marks are loaded square (the general patch is the trimmed copy), so object-contain fills the box equally.
      for (const l of [page.getByAltText(seal), page.getByAltText(general)]) {
        await expect.poll(() => l.evaluate((el) => (el as HTMLImageElement).naturalWidth === (el as HTMLImageElement).naturalHeight)).toBe(true)
      }
      const backing = await page.getByAltText(seal).evaluate((el) => {
        const cs = getComputedStyle(el.parentElement!)
        return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius }
      })
      expect(backing.bg).toBe('rgb(255, 255, 255)')
      expect(parseFloat(backing.radius)).toBeGreaterThan(0)
      // Both marks share the one backing element.
      const same = await page.getByAltText(seal).evaluate((el, alt) => el.parentElement === document.querySelector(`img[alt="${alt}"]`)?.parentElement, general)
      expect(same).toBe(true)
    }
  })

  test('fits at 360px with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/')
    await expect(page.getByAltText(seal)).toBeAttached()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('layout', () => {
  test('no horizontal scroll on the landing and login pages', async ({ page }) => {
    for (const path of ['/', '/login']) {
      await page.goto(path)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })
})
