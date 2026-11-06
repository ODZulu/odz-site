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

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
const card = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title })

test('a Member adds an opportunity and answers; Command sees who, promotes one and drops another', async ({ browser }) => {
  const member = await seedUser('member', 'opp-mem')
  const other = await seedUser('member', 'opp-oth')
  const cmd = await seedUser('command', 'opp-cmd')
  const promoteTitle = 'E2E Fake Weekend Game'
  const dropTitle = 'E2E Fake Clash Event'

  // Member, at phone width: add two opportunities, answer one In.
  const mp = await signInPage(browser, member)
  await mp.getByRole('link', { name: 'OPPORTUNITIES' }).click()
  await expect(mp).toHaveURL(/\/opportunities$/)
  for (const [title, start] of [[promoteTitle, '2030-03-09'], [dropTitle, '2030-04-01']]) {
    await mp.getByRole('button', { name: 'Add an opportunity' }).click()
    await mp.getByLabel('Title', { exact: true }).fill(title)
    await mp.getByLabel('Host or company').fill('Fake Host')
    await mp.getByLabel('Start date').fill(start)
    await mp.getByLabel('Location').fill('Fake Field')
    await mp.getByLabel('Estimated cost per person, dollars (optional)').fill('45.50')
    await mp.getByRole('button', { name: 'Add opportunity' }).click()
    await expect(card(mp, title)).toBeVisible()
  }
  expect(await noSideScroll(mp)).toBe(true)
  await expect(card(mp, promoteTitle).getByText('Cost: $45.50 per person')).toBeVisible()
  await card(mp, promoteTitle).getByRole('button', { name: 'In', exact: true }).click()
  await expect(card(mp, promoteTitle).getByText('1 In, 0 Maybe, 0 Out · You: In')).toBeVisible()
  await card(mp, dropTitle).getByRole('button', { name: 'Maybe' }).click()
  await expect(card(mp, dropTitle).getByText('0 In, 1 Maybe, 0 Out · You: Maybe')).toBeVisible()
  // A Member cannot promote or drop, and the names are not theirs to see.
  await expect(card(mp, promoteTitle).getByRole('button', { name: 'Promote to event' })).toHaveCount(0)
  await expect(card(mp, promoteTitle).getByRole('button', { name: 'Drop' })).toHaveCount(0)
  await card(mp, promoteTitle).getByRole('button', { name: 'Who answered' }).click()
  await expect(card(mp, promoteTitle).getByText('Names are shown to Old Guard and Command only.')).toBeVisible()

  // A second Member answers Out on the first.
  const op = await signInPage(browser, other)
  await op.goto('/opportunities')
  await card(op, promoteTitle).getByRole('button', { name: 'Out' }).click()
  await expect(card(op, promoteTitle).getByText('1 In, 0 Maybe, 1 Out · You: Out')).toBeVisible()

  // Command sees who answered, promotes the first, drops the second.
  const cp = await signInPage(browser, cmd)
  await cp.goto('/opportunities')
  await card(cp, promoteTitle).getByRole('button', { name: 'Who answered' }).click()
  await expect(card(cp, promoteTitle).getByText(`${member.callsign}: In`)).toBeVisible()
  await expect(card(cp, promoteTitle).getByText(`${other.callsign}: Out`)).toBeVisible()

  await card(cp, promoteTitle).getByRole('button', { name: 'Promote to event' }).click()
  await cp.getByLabel('Event type').selectOption('Op')
  await cp.getByRole('button', { name: 'Promote', exact: true }).click()
  await cp.getByRole('button', { name: 'Confirm promote' }).click()
  await expect(cp.getByRole('status').filter({ hasText: 'Promoted.' })).toBeVisible()
  const ev = await admin().from('events').select('id,event_type').eq('title', promoteTitle)
  expect(ev.data).toHaveLength(1)
  expect(ev.data?.[0].event_type).toBe('Op')
  // Nobody was registered for it.
  const rsvps = await admin().from('event_rsvps').select('profile_id', { count: 'exact', head: true }).eq('event_id', ev.data?.[0].id)
  expect(rsvps.count ?? 0).toBe(0)

  await card(cp, dropTitle).getByRole('button', { name: 'Drop' }).click()
  await cp.getByLabel('Reason for dropping').fill('Fake reason: clashes with another event')
  await cp.getByRole('button', { name: 'Drop', exact: true }).click()
  await cp.getByRole('button', { name: 'Confirm drop' }).click()
  await expect(cp.getByRole('status').filter({ hasText: 'Dropped.' })).toBeVisible()

  // In-app notifications: the In member is told of the promotion, the Out member is not; the Maybe member hears of the drop.
  const told = await admin().from('notifications').select('title').eq('profile_id', member.id).eq('kind', 'opportunity')
  expect((told.data ?? []).map((n: { title: string }) => n.title).sort()).toEqual([`Now an event: ${promoteTitle}`, `Opportunity dropped: ${dropTitle}`])
  const quiet = await admin().from('notifications').select('title').eq('profile_id', other.id).eq('kind', 'opportunity')
  expect((quiet.data ?? []).filter((n: { title: string }) => n.title.startsWith('Now an event'))).toHaveLength(0)

  // The Member's list: filters by status, and "I'm In" narrows it.
  await mp.reload()
  await expect(card(mp, promoteTitle)).toHaveCount(0) // Open filter: promoted is gone
  await mp.getByLabel('Show').selectOption('all')
  await expect(card(mp, promoteTitle).getByText('Promoted')).toBeVisible()
  await expect(card(mp, dropTitle).getByText('Dropped: Fake reason: clashes with another event')).toBeVisible()
  await mp.getByLabel("I'm In").check()
  await expect(card(mp, promoteTitle)).toBeVisible()
  await expect(card(mp, dropTitle)).toHaveCount(0)
})

test('RLS: a Recruit and the public get nothing; nobody writes the tables directly', async () => {
  const member = await seedUser('member', 'opp-rls-m')
  const recruit = await seedUser('recruit', 'opp-rls-r')
  const m = await asUser(member.email, member.password)
  const created = await m.rpc('opportunity_save', {
    p_id: null, p_title: 'E2E Fake RLS Event', p_host: null, p_source_url: null, p_starts_on: '2030-05-01', p_ends_on: null,
    p_location_text: null, p_latitude: null, p_longitude: null, p_est_cost_cents: null, p_notes: null,
  })
  expect(created.error).toBeNull()
  const id = created.data as string

  // Direct writes are closed, even to the creator.
  expect((await m.from('opportunities').update({ title: 'E2E hijack' }).eq('id', id)).error).not.toBeNull()
  expect((await m.from('opportunities').insert({ title: 'E2E direct', starts_on: '2030-05-02' })).error).not.toBeNull()
  expect((await m.from('opportunity_responses').insert({ opportunity_id: id, profile_id: member.id, response: 'In' })).error).not.toBeNull()

  const r = await asUser(recruit.email, recruit.password)
  expect((await r.rpc('opportunity_list')).error).not.toBeNull()
  expect((await r.from('opportunities').select('id')).data ?? []).toHaveLength(0)
  expect((await r.rpc('opportunity_respond', { p_opportunity: id, p_response: 'In' })).error).not.toBeNull()

  const anon = await asUser()
  expect((await anon.from('opportunities').select('id')).data ?? []).toHaveLength(0)
  expect((await anon.rpc('opportunity_list')).error).not.toBeNull()
})
