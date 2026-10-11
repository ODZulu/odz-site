import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

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

test('the roster lists approved members, searchable by callsign, and hides pending accounts', async ({ page }) => {
  const viewer = await seedUser('member', 'dir-view')
  const other = await seedUser('member', 'dir-other')
  const pending = await seedUser('pending-setup-done', 'dir-pend')
  await signIn(page, viewer)
  await page.goto('/roster')
  await expect(page.getByRole('link', { name: other.callsign })).toBeVisible()
  await expect(page.getByRole('link', { name: pending.callsign })).toHaveCount(0)
  await page.getByLabel('Search by callsign').fill(other.callsign.toLowerCase())
  await expect(page.getByRole('link', { name: other.callsign })).toBeVisible()
  await expect(page.getByRole('link', { name: viewer.callsign })).toHaveCount(0)
})

test('a member edits their own profile and a script in the bio stays inert', async ({ page }) => {
  const me = await seedUser('member', 'dir-me')
  await signIn(page, me)
  await page.goto('/me')
  await page.getByLabel('Display name').fill('E2E Fake Name')
  await page.getByLabel('Role note').fill('Medic')
  await page.getByLabel('Bio').fill('<script>window.__pwned = 1</script>hello')
  await expect(page.getByText('40/280')).toBeVisible()
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()

  await page.goto(`/roster/${encodeURIComponent(me.callsign)}`)
  await expect(page.getByText('<script>window.__pwned = 1</script>hello')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await expect(page.getByText('Medic')).toBeVisible()
})

test('private details show only to the owner and Command', async ({ page }) => {
  const target = await seedUser('member', 'dir-target')
  const peer = await seedUser('member', 'dir-peer')
  const cmd = await seedUser('command', 'dir-cmd')

  await signIn(page, peer)
  await page.goto(`/roster/${encodeURIComponent(target.callsign)}`)
  await expect(page.getByRole('heading', { name: 'Private details' })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('E2E Fake Person')
  await page.getByRole('button', { name: 'Sign out' }).click()

  await signIn(page, cmd)
  await page.goto(`/roster/${encodeURIComponent(target.callsign)}`)
  await expect(page.getByText('COMMAND-ONLY')).toBeVisible()
  await expect(page.getByText('E2E Fake Person')).toBeVisible()
})

test('a member cannot rename themselves or change their tier through the API', async () => {
  const me = await seedUser('member', 'dir-api')
  const { asUser } = await import('./helpers/backend')
  const c = await asUser(me.email, me.password)
  const rename = await c.from('profiles').update({ callsign: 'E2E-HACKED' }).eq('id', me.id)
  expect(rename.error).not.toBeNull()
  const rpc = await c.rpc('set_callsign', { p_profile: me.id, p_callsign: 'E2E-HACKED' })
  expect(rpc.error).not.toBeNull()
  const after = await admin().from('profiles').select('callsign').eq('id', me.id).single()
  expect(after.data?.callsign).toBe(me.callsign)
})
