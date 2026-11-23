import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, createEventRow, hasBackend, resetInviteAttempts, seedUser } from './helpers/backend'
import { eventPage, openEventFromList } from './helpers/events'
import { moveEventLater, phoenixDay, phoenixInstant } from './helpers/dates'

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

// MVA-301: an event's actions and sections are on its page, reached from the list.
const article = (page: Page, _title: string) => eventPage(page)

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

  // Preview, then apply (on the event's own page).
  await openEventFromList(cp, eventTitle)
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
  await expect(article(cp, eventTitle).getByRole('heading', { name: 'Prep timeline' })).toBeVisible()
  // The prep meeting links back to its source event.
  await article(cp, eventTitle).getByRole('link', { name: `${eventTitle}: Briefing` }).click()
  await expect(cp.getByRole('heading', { level: 1, name: `${eventTitle}: Briefing`, exact: true })).toBeVisible()
  await expect(article(cp, eventTitle).getByText('Prep meeting for')).toBeVisible()
  await article(cp, eventTitle).getByRole('link', { name: eventTitle, exact: true }).click()
  await expect(cp.getByRole('heading', { level: 1, name: eventTitle, exact: true })).toBeVisible()

  // The prep meeting is Command-only: invisible to a Member and to the public.
  const m = await asUser(mem.email, mem.password)
  expect((await m.from('events').select('id').eq('source_event_id', ev.id)).data ?? []).toHaveLength(0)
  expect((await (await asUser()).from('events').select('id').eq('title', `${eventTitle}: Briefing`)).data ?? []).toHaveLength(0)

  // Applying again changes nothing.
  await cp.reload()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Apply prep cadence' }).click()
  await article(cp, eventTitle).first().getByLabel('Prep cadence').selectOption({ label: 'E2E Fake Op prep' })
  await expect(article(cp, eventTitle).first().getByText(/Briefing: .*Already matches/)).toBeVisible()

  // Move the event five Phoenix days later: the prep meeting keeps its seven-day offset. The date to
  // type and the expected shift both come from the event's own seeded start, so the test gives the same
  // answer at any time of day and across month and year boundaries (MVA-298).
  const eventBefore = await admin().from('events').select('starts_at').eq('id', ev.id).single()
  const before = new Date(made.data?.[0].starts_at as string).getTime()
  const move = moveEventLater(eventBefore.data?.starts_at as string, 5)
  expect(move.shiftDays).toBe(5)
  await article(cp, eventTitle).first().getByRole('link', { name: 'Edit' }).click()
  await cp.getByLabel('Starts (Phoenix time)').fill(move.input)
  await cp.getByLabel('Ends (optional)').fill('')
  await cp.getByRole('button', { name: 'Save event' }).click()
  await expect(cp.getByRole('button', { name: /^(Save event|Saving)$/ })).toHaveCount(0)
  const moved = await admin().from('events').select('starts_at').eq('source_event_id', ev.id).single()
  // The event itself landed on the day we typed, and the meeting moved by exactly the same whole days
  // at the same time of day (Phoenix has no daylight saving, so no rounding is needed).
  const eventAfter = await admin().from('events').select('starts_at').eq('id', ev.id).single()
  expect(new Date(eventAfter.data?.starts_at as string).getTime()).toBe(phoenixInstant(move.input).getTime())
  expect(phoenixDay(eventAfter.data?.starts_at as string)).toBe(move.input.slice(0, 10))
  expect(new Date(moved.data?.starts_at as string).getTime() - before).toBe(move.shiftDays * 86_400_000)

  // Cancel the event: its future prep meeting is cancelled too.
  await cp.reload()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Cancel event' }).click()
  await article(cp, eventTitle).first().getByRole('button', { name: 'Confirm cancel' }).click()
  await expect(article(cp, eventTitle).first().getByText('CANCELLED', { exact: true })).toBeVisible()
  const after = await admin().from('events').select('status').eq('source_event_id', ev.id).single()
  expect(after.data?.status).toBe('cancelled')
})
