import { expect, test, type Page } from '@playwright/test'
import { cleanup, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
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

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link')

test('a member cannot reach /admin and sees no admin tab', async ({ page }) => {
  await signIn(page, await seedUser('member', 'adm-mem'))
  await expect(page.getByRole('link', { name: 'ADMIN' })).toHaveCount(0)
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/hq$/)
  await page.goto('/admin/tiers')
  await expect(page).toHaveURL(/\/hq$/)
})

test('Command sees invites, pending, members and audit but not tiers', async ({ page }) => {
  await signIn(page, await seedUser('command', 'adm-cmd'))
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/invites$/)
  await expect(tabs(page)).toHaveText(['Invites', 'Pending', 'Members', 'Audit'])
  await page.goto('/admin/tiers')
  await expect(page).toHaveURL(/\/admin\/invites$/)
})

test('Admin sees every section', async ({ page }) => {
  await signIn(page, await seedUser('admin', 'adm-admin'))
  await page.goto('/admin')
  await expect(tabs(page)).toHaveText(['Invites', 'Pending', 'Members', 'Tiers', 'Audit'])
})

test('an invite code is shown in full once, then only its last four characters', async ({ page }) => {
  await signIn(page, await seedUser('command', 'adm-inv'))
  await page.goto('/admin/invites')
  await page.getByLabel('Note (optional)').fill('e2e-shown-once')
  await page.getByRole('button', { name: 'Create invite' }).click()

  const shown = page.getByTestId('new-invite-code')
  await expect(shown).toBeVisible()
  const full = (await shown.innerText()).replace(/-/g, '')
  expect(full.length).toBeGreaterThanOrEqual(10)

  await page.reload()
  await expect(page.getByTestId('new-invite-code')).toHaveCount(0)
  const body = await page.locator('body').innerText()
  expect(body).not.toContain(full)
  expect(body).toContain(`**** **** **** ${full.slice(-4)}`)
})

test('Admin cannot strip approve_members from the only tier that has it', async ({ page }) => {
  await signIn(page, await seedUser('admin', 'adm-lock'))
  await page.goto('/admin/tiers')
  const command = page.locator('section', { hasText: '1. Command' })
  await command.getByLabel('approve_members').uncheck()
  await expect(page.getByRole('alert').first()).toContainText('at least one tier')
  await expect(command.getByLabel('approve_members')).toBeChecked()
})

test('changing private-details access needs the typed word', async ({ page }) => {
  await signIn(page, await seedUser('admin', 'adm-priv'))
  await page.goto('/admin/tiers')
  const member = page.locator('section', { hasText: /3\. Member/ })
  await member.getByLabel('view_member_private').check()
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Type PRIVATE').fill('private')
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Type PRIVATE').fill('PRIVATE')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(member.getByLabel('view_member_private')).toBeChecked()
  // Put it back so the run leaves the stack as it found it.
  await member.getByLabel('view_member_private').uncheck()
  await page.getByLabel('Type PRIVATE').fill('PRIVATE')
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(member.getByLabel('view_member_private')).not.toBeChecked()
})
