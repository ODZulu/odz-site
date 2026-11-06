import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser } from './helpers/backend'

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

// Match the card by its exact heading: a prep meeting's title contains its event's title.
const article = (page: Page, title: string) =>
  page.locator('article.odz-event').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
const localStamp = (days: number) => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T10:00`

test('Command builds a prep cadence, applies it (past steps are skipped and named), moves the event, then cancels it', async ({ browser }) => {
  const cmd = await seedUser('command', 'cad-cmd')
  const mem = await seedUser('member', 'cad-mem')
  const eventTitle = 'E2E Fake Prep Op'
  const ev = await createEventRow({ title: eventTitle, inDays: 20 })

  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  expect(await cp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Build the template: a 30-day step (already too late for an event 20 days away) and a 7-day step.
  await cp.getByRole('button', { name: 'New prep cadence' }).click()
  await cp.getByLabel('Template name').fill('E2E Fake Op prep')
  await cp.getByLabel('Title', { exact: true }).first().fill('Kick-off')
  await cp.getByLabel('Days before the event').first().fill('30')
  await cp.getByLabel('Agenda topics').first().fill('Scope and roles')
  await cp.getByRole('button', { name: 'Add a step' }).click()
  await cp.getByLabel('Title', { exact: true }).nth(1).fill('Briefing')
  await cp.getByLabel('Days before the event').nth(1).fill('7')
  await cp.getByLabel('Agenda topics').nth(1).fill('Final plan and kit')
  await cp.getByRole('button', { name: 'Save template' }).click()
  await expect(cp.getByRole('listitem').filter({ hasText: 'E2E Fake Op prep' })).toContainText('2 steps')

  // Preview, then apply.
  await article(cp, eventTitle).getByRole('button', { name: 'Apply prep cadence' }).click()
  await article(cp, eventTitle).getByLabel('Prep cadence').selectOption({ label: 'E2E Fake Op prep' })
  await expect(article(cp, eventTitle).getByText(/Kick-off: .*Skipped: that date has already passed/)).toBeVisible()
  await expect(article(cp, eventTitle).getByText(/Briefing: .*Will be created/)).toBeVisible()
  await article(cp, eventTitle).getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(article(cp, eventTitle).getByRole('status').filter({ hasText: 'Created 1, updated 0.' })).toContainText('Skipped (date already passed): Kick-off.')

  const made = await admin().from('events').select('id,title,audience,starts_at,source_event_id').eq('source_event_id', ev.id)
  expect(made.data).toHaveLength(1)
  expect(made.data?.[0].title).toBe(`${eventTitle}: Briefing`)
  expect(made.data?.[0].audience).toBe('command')
  await expect(article(cp, eventTitle).first().getByText('Prep timeline (1)')).toBeVisible()
  await expect(article(cp, `${eventTitle}: Briefing`).getByText('PREP', { exact: true })).toBeVisible()

  // The prep meeting is Command-only: invisible to a Member and to the public.
  const m = await asUser(mem.email, mem.password)
  expect((await m.from('events').select('id').eq('source_event_id', ev.id)).data ?? []).toHaveLength(0)
  expect((await (await asUser()).from('events').select('id').eq('title', `${eventTitle}: Briefing`)).data ?? []).toHaveLength(0)

  // Applying again changes nothing.
  await cp.reload()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Apply prep cadence' }).click()
  await article(cp, eventTitle).first().getByLabel('Prep cadence').selectOption({ label: 'E2E Fake Op prep' })
  await expect(article(cp, eventTitle).first().getByText(/Briefing: .*Already matches/)).toBeVisible()

  // Move the event five days later: the prep meeting keeps its seven-day offset.
  const before = new Date(made.data?.[0].starts_at as string).getTime()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Edit' }).click()
  await cp.getByLabel('Starts (Phoenix time)').fill(localStamp(25))
  await cp.getByLabel('Ends (optional)').fill('')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(cp.getByRole('button', { name: 'Save event' })).toHaveCount(0)
  const moved = await admin().from('events').select('starts_at').eq('source_event_id', ev.id).single()
  const shift = (new Date(moved.data?.starts_at as string).getTime() - before) / 86_400_000
  expect(Math.round(shift)).toBe(5)

  // Cancel the event: its future prep meeting is cancelled too.
  await cp.reload()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Cancel event' }).click()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Confirm cancel' }).click()
  await expect(article(cp, eventTitle).first().getByText('CANCELLED')).toBeVisible()
  const after = await admin().from('events').select('status').eq('source_event_id', ev.id).single()
  expect(after.data?.status).toBe('cancelled')
})
