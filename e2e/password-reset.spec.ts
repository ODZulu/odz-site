import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, hasBackend, resetInviteAttempts, seedUser, uniq } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

const NEUTRAL = 'If that address has an account, a reset link is on its way.'
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:54324'
const NEW_PASSWORD = 'Fake-New-Password-12345'

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
}

test('login links to the forgot-password page, which gives the neutral message for an unknown address', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await expect(page).toHaveURL(/\/forgot-password$/)
  await page.getByLabel('Email').fill(`nobody-${uniq()}@example.invalid`)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText(NEUTRAL)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a malformed address is rejected before anything is sent', async ({ page }) => {
  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill('not-an-address')
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByText('Enter a valid email address.')).toBeVisible()
  await expect(page.getByText(NEUTRAL)).toHaveCount(0)
})

test('the reset page without a recovery link shows the generic error and a way back', async ({ page }) => {
  await page.goto('/reset-password')
  await expect(page.getByRole('alert')).toContainText('not valid any more')
  await page.getByRole('link', { name: 'Request a new link' }).click()
  await expect(page).toHaveURL(/\/forgot-password$/)
})

test('an ordinary signed-in session cannot use the reset page to skip the current password', async ({ page }) => {
  const u = await seedUser('member', 'pr-plain')
  await signIn(page, u)
  await expect(page).toHaveURL(/\/hq$/)
  await page.goto('/reset-password')
  await expect(page.getByRole('alert')).toContainText('not valid any more')
  await expect(page.getByLabel('New password')).toHaveCount(0)
})

async function mailpitLink(email: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
      const found = (await list.json()) as { messages?: { ID: string }[] }
      const id = found.messages?.[0]?.ID
      if (id) {
        const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string }
        const m = /https?:\/\/[^\s"<>)]+/.exec((msg.Text ?? '').replace(/&amp;/g, '&')) ?? /https?:\/\/[^\s"<>)]+verify[^\s"<>)]*/.exec((msg.HTML ?? '').replace(/&amp;/g, '&'))
        if (m) return m[0]
      }
    } catch {
      return null
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  return null
}

test('full reset through the local mail catcher: new password works, old does not; a link is single-use; a suspended account stays out', async ({ page, browser }) => {
  const probe = await fetch(`${MAILPIT}/api/v1/info`).then((r) => r.ok).catch(() => false)
  test.skip(!probe, 'needs the local Supabase mail catcher (Mailpit)')
  const u = await seedUser('member', 'pr-flow')
  // Suspended before the reset: a reset must not bypass the existing gate.
  expect((await admin().from('profiles').update({ status: 'suspended' }).eq('id', u.id)).error).toBeNull()

  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(u.email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText(NEUTRAL)

  const link = await mailpitLink(u.email)
  expect(link, 'a reset email arrived').not.toBeNull()
  await page.goto(link!)
  await expect(page).toHaveURL(/\/reset-password/)
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible()

  // Validators: too short, then mismatch.
  await page.getByLabel('New password', { exact: true }).fill('short')
  await page.getByLabel('Confirm new password').fill('short')
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByText(/at least 12 characters/i)).toBeVisible()
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Confirm new password').fill(`${NEW_PASSWORD}x`)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByText('The two passwords do not match.')).toBeVisible()

  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('status')).toContainText('Your password was changed')

  // Old password fails; the new one signs in but the suspended gate still holds.
  await signIn(page, u)
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible()
  await signIn(page, { email: u.email, password: NEW_PASSWORD })
  await expect(page).toHaveURL(/\/denied$/)

  // The same link in a fresh browser is dead: one generic message.
  const ctx = await browser.newContext()
  const other = await ctx.newPage()
  await other.goto(link!)
  await expect(other.getByRole('alert')).toContainText('not valid any more')
  await ctx.close()
})
