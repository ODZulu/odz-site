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

const article = (page: Page, title: string) => page.locator('article.odz-event').filter({ hasText: title })
const openRegistration = async (page: Page, title: string) => {
  await page.goto('/calendar')
  await article(page, title).getByText('Registration', { exact: true }).click()
}

test('Command requires registration with a capacity of one; the second member waitlists and is promoted on withdrawal', async ({ browser }) => {
  const cmd = await seedUser('command', 'reg-cmd')
  const m1 = await seedUser('member', 'reg-m1')
  const m2 = await seedUser('member', 'reg-m2')
  const ev = await createEventRow({ title: 'E2E Registration Event', inDays: 14 })

  // RSVP is what the event shows until Command switches it to registration.
  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  await expect(article(cp, ev.title).getByText('RSVP and readiness')).toBeVisible()
  await article(cp, ev.title).getByRole('button', { name: 'Require registration' }).click()
  await expect(article(cp, ev.title).getByText('RSVP and readiness')).toHaveCount(0)
  await article(cp, ev.title).getByText('Registration', { exact: true }).click()
  await article(cp, ev.title).getByText('Registration settings').click()
  await article(cp, ev.title).getByLabel('Capacity (empty for no limit)').fill('1')
  await article(cp, ev.title).getByRole('button', { name: 'Save settings' }).click()
  await cp.reload()
  await article(cp, ev.title).getByText('Registration', { exact: true }).click()
  await expect(article(cp, ev.title).getByText('0 of 1 places taken.')).toBeVisible()

  // First member registers; the second is waitlisted.
  const p1 = await signInPage(browser, m1)
  await openRegistration(p1, ev.title)
  await article(p1, ev.title).getByRole('button', { name: 'Register' }).click()
  await expect(article(p1, ev.title).getByText('You: Registered')).toBeVisible()
  expect(await p1.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const p2 = await signInPage(browser, m2)
  await openRegistration(p2, ev.title)
  await expect(article(p2, ev.title).getByText('Full: new registrations join the waitlist.')).toBeVisible()
  await article(p2, ev.title).getByRole('button', { name: 'Join the waitlist' }).click()
  await expect(article(p2, ev.title).getByText('You: Waitlisted (number 1)')).toBeVisible()
  // Another registrant (m2) sees the list; names show for registrants.
  await expect(article(p2, ev.title).getByText(`${m1.callsign}: Registered`)).toBeVisible()

  // The first withdraws freely (the cutoff is a week before the start); the second moves up and is told.
  await article(p1, ev.title).getByRole('button', { name: 'Withdraw' }).click()
  await article(p1, ev.title).getByRole('button', { name: 'Confirm withdraw' }).click()
  await expect(article(p1, ev.title).getByText('You: Withdrawn')).toBeVisible()
  await openRegistration(p2, ev.title)
  await expect(article(p2, ev.title).getByText('You: Registered')).toBeVisible()
  const told = await admin().from('notifications').select('title').eq('profile_id', m2.id).eq('kind', 'registration')
  expect((told.data ?? []).map((n: { title: string }) => n.title)).toEqual([`You are in: ${ev.title}`])
})

test('Command marks attendance after the event, adds a walk-in, confirms, and attendance lands in service records', async ({ browser }) => {
  const cmd = await seedUser('command', 'att-cmd')
  const m1 = await seedUser('member', 'att-m1')
  const m2 = await seedUser('member', 'att-m2')
  const walker = await seedUser('member', 'att-walk')
  const title = 'E2E Attendance Event'
  const start = new Date(Date.now() - 2 * 86_400_000)
  const ev = await admin()
    .from('events')
    .insert({ title, event_type: 'Op', starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 7_200_000).toISOString() })
    .select('id')
    .single()
  expect(ev.error).toBeNull()
  const eventId = ev.data!.id as string
  await admin().from('event_details').insert({ event_id: eventId, location_name: 'Fake Field' })

  const c = await asUser(cmd.email, cmd.password)
  expect((await c.rpc('event_registration_configure', { p_event: eventId, p_opens_at: null, p_closes_at: null, p_capacity: null, p_cutoff_at: null })).error).toBeNull()
  expect((await admin().from('event_registrations').insert([
    { event_id: eventId, profile_id: m1.id, state: 'registered' },
    { event_id: eventId, profile_id: m2.id, state: 'registered' },
  ])).error).toBeNull()

  const cp = await signInPage(browser, cmd)
  await cp.goto('/calendar')
  await cp.getByText(/Past events/).click()
  const a = article(cp, title)
  await a.getByText('Registration', { exact: true }).click()
  const row = (callsign: string) => a.locator('div.odz-row').filter({ hasText: callsign })

  // Confirming needs everyone marked.
  await row(m1.callsign).getByRole('button', { name: 'Attended' }).click()
  await a.getByRole('button', { name: 'Confirm attendance' }).click()
  await a.getByRole('button', { name: 'Yes, confirm attendance' }).click()
  await expect(a.getByText('Mark every registrant before confirming.')).toBeVisible()

  await row(m2.callsign).getByRole('button', { name: 'No-show' }).click()
  await expect(row(m2.callsign).getByRole('button', { name: 'No-show' })).toHaveAttribute('aria-pressed', 'true')

  // Walk-in needs a reason.
  await a.getByText('Add a walk-in').click()
  await a.getByLabel('Member').last().selectOption({ label: walker.callsign })
  await a.getByLabel('Reason').last().fill('Fake: turned up on the day')
  await a.getByRole('button', { name: 'Add as attended' }).click()
  await expect(a.getByText(`${walker.callsign}: Registered (walk-in), Attended`)).toBeVisible()

  await a.getByRole('button', { name: 'Confirm attendance' }).click()
  await a.getByRole('button', { name: 'Yes, confirm attendance' }).click()
  await expect(a.getByText('COMPLETED')).toBeVisible()

  const status = await admin().from('events').select('status').eq('id', eventId).single()
  expect(status.data?.status).toBe('completed')
  const history = await admin().from('service_history').select('profile_id,source,title').eq('title', title)
  const who = (history.data ?? []).map((h: { profile_id: string }) => h.profile_id).sort()
  expect(who).toEqual([m1.id, walker.id].sort())
  expect((history.data ?? []).every((h: { source: string }) => h.source === 'app')).toBe(true)

  // A member sees their own result and a Member cannot mark anyone.
  const p2 = await signInPage(browser, m2)
  await p2.goto('/calendar')
  await p2.getByText(/Past events/).click()
  await article(p2, title).getByText('Registration', { exact: true }).click()
  await expect(article(p2, title).getByText('Result: No-show')).toBeVisible()
  await expect(article(p2, title).getByRole('button', { name: 'Attended' })).toHaveCount(0)
  const m = await asUser(m2.email, m2.password)
  expect((await m.rpc('event_attendance_set', { p_event: eventId, p_member: m2.id, p_result: 'attended', p_reason: 'Fake reason' })).error).not.toBeNull()
})
