import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

const NEW_PASSWORD = 'e2e-New-Fake-Passw0rd-7'

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

async function signIn(page: Page, u: { email: string; password: string }, landing: RegExp = /\/hq$/) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(landing)
}

async function fill(page: Page, current: string, next: string, confirm: string) {
  await page.getByLabel('Current password', { exact: true }).fill(current)
  await page.getByLabel('New password', { exact: true }).fill(next)
  await page.getByLabel('Confirm new password', { exact: true }).fill(confirm)
}

test('change password: the new one works, the old one fails, other sessions end, and an audit row is written without a secret', async ({ page }) => {
  const u = await seedUser('member', 'pw-ok')
  const other = await asUser(u.email, u.password) // a second device, signed in before the change
  expect((await other.auth.getSession()).data.session).not.toBeNull()

  await signIn(page, u)
  await page.goto('/me')
  await fill(page, u.password, NEW_PASSWORD, NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed. Other devices were signed out.')).toBeVisible()

  // The three fields are cleared, and this session stays signed in.
  await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Confirm new password', { exact: true })).toHaveValue('')
  await page.goto('/hq')
  await expect(page).toHaveURL(/\/hq$/)

  // The other device can no longer refresh its session.
  const refreshed = await other.auth.refreshSession()
  expect(refreshed.error).not.toBeNull()

  // Old password fails, new password works.
  await expect(asUser(u.email, u.password)).rejects.toThrow()
  await asUser(u.email, NEW_PASSWORD)

  // Audit: who and when, nothing secret anywhere in the row.
  const rows = await admin().from('profile_audit').select('*').eq('profile_id', u.id).eq('event', 'password_changed')
  expect(rows.data).toHaveLength(1)
  expect(rows.data![0]).toMatchObject({ actor_id: u.id, old_value: 'password', new_value: 'changed', note: null })
  const blob = JSON.stringify(rows.data)
  expect(blob).not.toContain(NEW_PASSWORD)
  expect(blob).not.toContain(u.password)
})

test('a wrong current password shows one generic error and changes nothing; five wrong attempts turn the form off', async ({ page }) => {
  const u = await seedUser('member', 'pw-bad')
  await signIn(page, u)
  await page.goto('/me')

  await fill(page, 'e2e-Wrong-Passw0rd-x', NEW_PASSWORD, NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Current password is incorrect' })).toBeVisible()
  await asUser(u.email, u.password) // the old password still works
  await expect(asUser(u.email, NEW_PASSWORD)).rejects.toThrow()
  const none = await admin().from('profile_audit').select('id').eq('profile_id', u.id).eq('event', 'password_changed')
  expect(none.data).toHaveLength(0)

  for (let i = 0; i < 4; i++) {
    await page.getByLabel('Current password', { exact: true }).fill(`e2e-Wrong-Passw0rd-${i}`)
    await page.getByRole('button', { name: 'Change password' }).click()
  }
  await expect(page.getByText(/Too many wrong attempts/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled()
  await expect(page.getByLabel('Current password', { exact: true })).toBeDisabled()

  // The lock holds across a reload in the same browser session.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled()
})

test('live validation: 11 characters, the same password, and a mismatch are all rejected before anything is sent', async ({ page }) => {
  const u = await seedUser('member', 'pw-val')
  await signIn(page, u)
  await page.goto('/me')

  await fill(page, u.password, 'a'.repeat(11), 'a'.repeat(11))
  await expect(page.getByText('Use at least 12 characters.')).toBeVisible()
  await fill(page, u.password, u.password, u.password)
  await expect(page.getByText('The new password must be different from the current one.')).toBeVisible()
  await fill(page, u.password, NEW_PASSWORD, `${NEW_PASSWORD}-typo`)
  await expect(page.getByText('The two new passwords do not match.')).toBeVisible()

  await page.getByRole('button', { name: 'Change password' }).click()
  const none = await admin().from('profile_audit').select('id').eq('profile_id', u.id).eq('event', 'password_changed')
  expect(none.data).toHaveLength(0)
  await asUser(u.email, u.password)

  // Fits at 360px.
  await page.setViewportSize({ width: 360, height: 800 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  // Show / hide toggle, and the password-manager hints.
  const next = page.getByLabel('New password', { exact: true })
  await expect(next).toHaveAttribute('type', 'password')
  await expect(next).toHaveAttribute('autocomplete', 'new-password')
  await expect(page.getByLabel('Current password', { exact: true })).toHaveAttribute('autocomplete', 'current-password')
  await page.getByRole('button', { name: 'Show new password' }).click()
  await expect(next).toHaveAttribute('type', 'text')
})

test('it works for a Support account and for a retired account; a plain pending account never reaches it', async ({ page, browser }) => {
  const sup: SeededUser = await seedUser('support', 'pw-sup')
  await signIn(page, sup)
  await page.goto('/me')
  await fill(page, sup.password, NEW_PASSWORD, NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed. Other devices were signed out.')).toBeVisible()
  await asUser(sup.email, NEW_PASSWORD)

  const ret = await seedUser('member', 'pw-ret')
  await admin().from('profiles').update({ status: 'retired' }).eq('id', ret.id)
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await signIn(p2, ret, /\/retired$/)
  await fill(p2, ret.password, NEW_PASSWORD, NEW_PASSWORD)
  await p2.getByRole('button', { name: 'Change password' }).click()
  await expect(p2.getByText('Password changed. Other devices were signed out.')).toBeVisible()
  await ctx.close()

  const pend = await seedUser('pending-setup-done', 'pw-pend')
  const ctx2 = await browser.newContext()
  const p3 = await ctx2.newPage()
  await signIn(p3, pend, /\/pending$/)
  await p3.goto('/me')
  await expect(p3).toHaveURL(/\/pending$/)
  const asPend = await asUser(pend.email, pend.password)
  const refused = await asPend.rpc('log_password_change')
  expect(refused.error?.message).toBe('not allowed')
  await ctx2.close()
})
