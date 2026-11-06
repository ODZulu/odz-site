import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

async function signInPage(browser: Browser, u: { email: string; password: string }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
  return page
}

const article = (page: Page, title: string) => page.locator('article.odz-event').filter({ hasText: title })
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

test('Command makes a Command-only weekly series; lower tiers and the public never see it; one instance is edited, the series is edited, an event is duplicated, the series is cancelled', async ({ browser }) => {
  const cmd = await seedUser('command', 'ser-cmd')
  const mem = await seedUser('member', 'ser-mem')
  const base = 'E2E Fake Standing'

  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  expect(await cp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await cp.getByRole('button', { name: 'New standing meeting' }).click()
  await cp.getByLabel('Title', { exact: true }).fill(base)
  await cp.getByLabel('First date').fill(inDays(2))
  await cp.getByLabel('Repeats').selectOption('weekly')
  await cp.getByLabel('Every how many weeks').fill('1')
  await cp.getByRole('button', { name: 'Create series' }).click()
  await expect(cp.getByRole('listitem').filter({ hasText: /Every week on/ })).toBeVisible()
  await expect(article(cp, base).first()).toBeVisible()
  await expect(article(cp, base).first().getByText('COMMAND ONLY')).toBeVisible()

  // The database has 12-14 real instances, and only Command can see any of them.
  const total = (await admin().from('events').select('id', { count: 'exact', head: true }).eq('title', base)).count ?? 0
  expect(total).toBeGreaterThanOrEqual(12)
  expect(total).toBeLessThanOrEqual(14)
  const m = await asUser(mem.email, mem.password)
  expect((await m.from('events').select('id').eq('title', base)).data ?? []).toHaveLength(0)
  const anon = await asUser()
  expect((await anon.from('events').select('id').eq('title', base)).data ?? []).toHaveLength(0)
  const mp = await signInPage(browser, mem)
  await mp.goto('/calendar')
  await expect(article(mp, base)).toHaveCount(0)
  await expect(mp.getByText('Standing meetings')).toHaveCount(0)

  // Edit one instance by hand.
  await article(cp, base).first().getByRole('button', { name: 'Edit' }).click()
  await expect(cp.getByText('belongs to a standing series')).toBeVisible()
  await cp.getByLabel('Title', { exact: true }).fill(`${base} One-off`)
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(article(cp, `${base} One-off`)).toHaveCount(1)

  // Edit the series: every other future instance changes, the hand-edited one does not.
  await cp.getByRole('listitem').filter({ hasText: /Every week on/ }).getByRole('button', { name: 'Edit' }).click()
  await cp.getByLabel('Title', { exact: true }).fill(`${base} Renamed`)
  await cp.getByRole('button', { name: 'Save series' }).click()
  await expect(cp.getByRole('listitem').filter({ hasText: `${base} Renamed` })).toBeVisible()
  const renamed = (await admin().from('events').select('id', { count: 'exact', head: true }).eq('title', `${base} Renamed`)).count ?? 0
  const oneOff = (await admin().from('events').select('id', { count: 'exact', head: true }).eq('title', `${base} One-off`)).count ?? 0
  expect(oneOff).toBe(1)
  expect(renamed).toBe(total - 1)

  // Duplicate an event: same title, type and audience, a new date, no RSVPs.
  await article(cp, `${base} Renamed`).first().getByRole('button', { name: 'Duplicate' }).click()
  await expect(cp.getByLabel('Title', { exact: true })).toHaveValue(`${base} Renamed`)
  await expect(cp.getByLabel('Starts (Phoenix time)')).toHaveValue('')
  await cp.getByLabel('Starts (Phoenix time)').fill('2030-01-05T10:00')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(cp.getByRole('button', { name: 'Save event' })).toHaveCount(0) // saved, audience applied
  const dup = await admin().from('events').select('id,audience,series_id').eq('title', `${base} Renamed`).gte('starts_at', '2029-12-31')
  expect(dup.data).toHaveLength(1)
  expect(dup.data?.[0].audience).toBe('command')
  expect(dup.data?.[0].series_id).toBeNull()

  // Cancel the series: every future instance is cancelled, the duplicate (not in the series) is not.
  await cp.getByRole('listitem').filter({ hasText: /Every week on/ }).getByRole('button', { name: 'Cancel series' }).click()
  await cp.getByRole('button', { name: /Confirm: cancel all future meetings/ }).click()
  await expect(cp.getByRole('listitem').filter({ hasText: '(cancelled)' })).toBeVisible()
  const left = await admin().from('events').select('id', { count: 'exact', head: true }).like('title', `${base}%`).eq('status', 'scheduled').not('series_id', 'is', null)
  expect(left.count ?? 0).toBe(0)
})

test('a public event stays public; restricting it hides it from the public API', async ({ browser }) => {
  const cmd = await seedUser('command', 'aud-cmd')
  const title = 'E2E Fake Audience Event'
  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  await cp.getByRole('button', { name: 'New event' }).click()
  await cp.getByLabel('Title', { exact: true }).fill(title)
  await cp.getByLabel('Starts (Phoenix time)').fill('2030-02-02T10:00')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(article(cp, title)).toBeVisible()
  const anon = await asUser()
  expect((await anon.from('events').select('id').eq('title', title)).data).toHaveLength(1)

  await article(cp, title).getByRole('button', { name: 'Edit' }).click()
  await cp.getByLabel('Who can see this event').selectOption('command')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(article(cp, title).getByText('COMMAND ONLY')).toBeVisible()
  expect((await anon.from('events').select('id').eq('title', title)).data ?? []).toHaveLength(0)
})
