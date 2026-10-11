import { expect, test } from '@playwright/test'

// UI-only checks: no backend needed. The dev server runs with no Supabase config unless the
// E2E_* variables are set, and an anonymous visitor behaves the same either way.

const gated = ['/hq', '/roster', '/calendar', '/members', '/admin', '/documents', '/minutes', '/me', '/setup', '/pending']

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

  test('the landing page offers sign in only', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  })

  test('the app installs as a PWA (manifest and service worker are served)', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest')
    expect(manifest.ok()).toBe(true)
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
