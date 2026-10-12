import { expect, test } from '@playwright/test'
import {
  admin,
  cleanup,
  createInvite,
  fakeCallsign,
  fakeEmail,
  hasBackend,
  PASSWORD,
  resetInviteAttempts,
  seedUser,
} from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

async function signIn(page: import('@playwright/test').Page, email: string, password = PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('valid invite: join, account setup, then the pending screen', async ({ page }) => {
  const code = await createInvite()
  const email = fakeEmail('join')

  await page.goto(`/join/${code}`)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // Setup is required before anything else.
  await expect(page).toHaveURL(/\/setup$/)
  await page.goto('/hq')
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByLabel('Callsign').fill(fakeCallsign())
  await page.getByLabel('Full legal name').fill('E2E Fake Person')
  await page.getByLabel('Date of birth').fill('2000-01-01')
  await page.getByLabel('Allergies', { exact: true }).fill('None')
  await page.getByLabel('Emergency contact name').fill('E2E Fake Contact')
  await page.getByLabel('Emergency contact relationship').fill('Friend')
  await page.getByLabel('Emergency contact phone').fill('(555) 010-0101')
  await page.getByRole('button', { name: 'Save and continue' }).click()

  await expect(page).toHaveURL(/\/pending$/)
  await expect(page.getByRole('heading', { name: 'Account pending approval' })).toBeVisible()
  await page.goto('/roster')
  await expect(page).toHaveURL(/\/pending$/)
})

test('unknown, used, expired and revoked codes all give the identical error', async ({ page }) => {
  const used = await createInvite()
  // Redeem it the way a real signup does, so it is genuinely used.
  const u = await admin().auth.admin.createUser({
    email: fakeEmail('usedby'),
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { invite_code: used },
  })
  expect(u.error).toBeNull()

  const expired = await createInvite({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
  const revoked = await createInvite({ revoked: true })

  const messages: string[] = []
  for (const code of ['not-a-real-code-0000', used, expired, revoked]) {
    await resetInviteAttempts()
    await page.goto(`/join/${code}`)
    await page.getByRole('button', { name: 'Continue' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    messages.push((await alert.innerText()).trim())
  }
  expect(new Set(messages).size).toBe(1)
  expect(messages[0]).toBe('Invite not valid.')
})

test('a pending account cannot reach the app', async ({ page }) => {
  const u = await seedUser('pending-setup-done', 'pend')
  await signIn(page, u.email)
  await expect(page).toHaveURL(/\/pending$/)
  for (const path of ['/hq', '/roster']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/pending$/)
  }
  // The calendar is public by design (MVA-201): a pending account gets the public frame, not the app shell.
  await page.goto('/calendar')
  await expect(page).toHaveURL(/\/calendar$/)
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
})

test('an account that skipped setup is sent to setup', async ({ page }) => {
  const u = await seedUser('pending', 'nosetup')
  await signIn(page, u.email)
  await expect(page).toHaveURL(/\/setup$/)
  await page.goto('/roster')
  await expect(page).toHaveURL(/\/setup$/)
})

test('an approved member reaches HQ', async ({ page }) => {
  const u = await seedUser('member', 'ok')
  await signIn(page, u.email)
  await expect(page).toHaveURL(/\/hq$/)
})

test('a wrong password says so without saying which part was wrong', async ({ page }) => {
  const u = await seedUser('member', 'wrongpw')
  await signIn(page, u.email, 'definitely-not-it-0000')
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.')
})
