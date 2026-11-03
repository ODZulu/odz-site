import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, uniq } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await admin().from('events').delete().like('title', 'E2E Meeting %')
  await cleanup()
})

async function signIn(page: Page, u: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

async function signedInPage(browser: Browser, u: { email: string; password: string }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } })
  const page = await ctx.newPage()
  await signIn(page, u)
  return page
}

async function meeting(title: string) {
  const start = new Date(Date.now() + 2 * 86_400_000)
  const { data, error } = await admin()
    .from('events')
    .insert({
      title,
      event_type: 'Meeting',
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
    })
    .select('id')
    .single()
  if (error || !data) throw new Error('could not create the e2e meeting')
  return data.id as string
}

test('Command builds and publishes an agenda; a Member sees only the Members-level items and never presenter notes; minutes are pre-filled', async ({ browser }) => {
  const cmd = await seedUser('command', 'ag-cmd')
  const member = await seedUser('member', 'ag-mem')
  const title = `E2E Meeting ${uniq()}`
  const eventId = await meeting(title)

  const p = await signedInPage(browser, cmd)
  await p.goto(`/agenda/${eventId}`)
  await p.getByRole('button', { name: 'Start an agenda' }).click()

  // Item 1: Members level, with presenter notes.
  await p.getByRole('button', { name: 'Add an item' }).click()
  await p.getByLabel('Item title').fill('Fake roll call')
  await p.getByLabel('Planned minutes').fill('20')
  await p.getByRole('textbox', { name: 'Presenter notes' }).fill('Fake presenter-only note')
  await p.getByRole('button', { name: 'Save item' }).click()
  await expect(p.getByText('1. Fake roll call')).toBeVisible()

  // Item 2: Command only.
  await p.getByRole('button', { name: 'Add an item' }).click()
  await p.getByLabel('Item title').fill('Fake command-only business')
  await p.getByLabel('Planned minutes').fill('20')
  await p.getByLabel('Who can see this item').selectOption('command')
  await p.getByRole('button', { name: 'Save item' }).click()
  await expect(p.getByText('2. Fake command-only business')).toBeVisible()

  // 40 planned minutes in a 30 minute meeting: the warning shows.
  await expect(p.getByText('This agenda runs 10 min over the meeting.')).toBeVisible()
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // A draft is invisible to a Member.
  const m = await signedInPage(browser, member)
  await m.goto(`/agenda/${eventId}`)
  await expect(m.getByText('There is no agenda for this meeting yet.')).toBeVisible()

  await p.getByRole('button', { name: 'Publish agenda' }).click()
  await expect(p.getByText('PUBLISHED', { exact: true })).toBeVisible()

  await m.reload()
  await expect(m.getByText('1. Fake roll call')).toBeVisible()
  await expect(m.getByText('Fake command-only business')).toHaveCount(0)
  await expect(m.getByText('Fake presenter-only note')).toHaveCount(0)
  await expect(m.getByRole('button', { name: 'Add an item' })).toHaveCount(0)
  expect(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Command sees everything, including the presenter note.
  await p.reload()
  await expect(p.getByText('Fake presenter-only note')).toBeVisible()
  await expect(p.getByText('Fake command-only business')).toBeVisible()

  // The member was notified.
  const notes = await admin().from('notifications').select('id').eq('profile_id', member.id).eq('kind', 'agenda')
  expect(notes.data?.length).toBeGreaterThan(0)

  // Minutes from the agenda: a draft, headings and outcome lines, no presenter notes or Command items.
  await p.getByRole('button', { name: 'Create minutes from agenda' }).click()
  await expect(p).toHaveURL(/\/minutes\/.+\/edit$/)
  const minutes = await admin().from('minutes').select('title,status,body_md').eq('title', `Minutes: ${title}`).single()
  expect(minutes.data?.status).toBe('draft')
  expect(minutes.data?.body_md).toContain('Fake roll call')
  expect(minutes.data?.body_md).toContain('**Outcome:**')
  expect(minutes.data?.body_md).not.toContain('Fake presenter-only note')
  expect(minutes.data?.body_md).not.toContain('Fake command-only business')
  await admin().from('minutes').delete().eq('title', `Minutes: ${title}`)

  await p.context().close()
  await m.context().close()
})

test('RLS: draft agendas, Command items and presenter notes are closed to a Member over the API; nobody but Command writes', async () => {
  const cmd = await seedUser('command', 'agrls-cmd')
  const member = await seedUser('member', 'agrls-mem')
  const presenter = await seedUser('member', 'agrls-pre')
  const eventId = await meeting(`E2E Meeting ${uniq()}`)

  const c = await asUser(cmd.email, cmd.password)
  const ag = await c.from('agendas').insert({ event_id: eventId }).select('id').single()
  expect(ag.error).toBeNull()
  const agendaId = ag.data?.id as string
  const mk = async (row: Record<string, unknown>) => {
    const r = await c.from('agenda_items').insert({ agenda_id: agendaId, position: 1, ...row }).select('id').single()
    expect(r.error).toBeNull()
    return r.data?.id as string
  }
  const open = await mk({ title: 'Fake open item' })
  const cmdOnly = await mk({ title: 'Fake command item', visibility: 'command' })
  const mine = await mk({ title: 'Fake presenter item', visibility: 'presenter', presenter_id: presenter.id })
  expect((await c.from('agenda_item_notes').insert({ item_id: mine, presenter_notes_md: 'Fake secret' })).error).toBeNull()
  expect((await c.from('agenda_item_notes').insert({ item_id: open, presenter_notes_md: 'Fake other secret' })).error).toBeNull()

  const m = await asUser(member.email, member.password)
  // Draft: nothing.
  expect((await m.from('agendas').select('id').eq('id', agendaId)).data).toHaveLength(0)
  expect((await m.from('agenda_items').select('id').eq('agenda_id', agendaId)).data).toHaveLength(0)

  expect((await c.rpc('publish_agenda', { p_agenda: agendaId })).error).toBeNull()

  expect((await m.from('agenda_items').select('id,title').eq('agenda_id', agendaId)).data?.map((r) => r.title)).toEqual(['Fake open item'])
  expect((await m.from('agenda_item_notes').select('item_id').in('item_id', [open, cmdOnly, mine])).data).toHaveLength(0)
  const p = await asUser(presenter.email, presenter.password)
  const seen = (await p.from('agenda_items').select('id').in('id', [open, cmdOnly, mine])).data?.map((r) => r.id).sort()
  expect(seen).toEqual([open, mine].sort())
  expect((await p.from('agenda_item_notes').select('item_id').in('item_id', [open, cmdOnly, mine])).data?.map((r) => r.item_id)).toEqual([mine])

  // Writes and publishing are Command's.
  expect((await m.from('agenda_items').insert({ agenda_id: agendaId, title: 'Fake hijack' })).error).not.toBeNull()
  expect((await m.rpc('publish_agenda', { p_agenda: agendaId })).error?.message).toBe('not allowed')
  expect((await m.rpc('create_minutes_from_agenda', { p_agenda: agendaId })).error?.message).toBe('not allowed')

  const anon = await asUser()
  expect((await anon.from('agenda_items').select('id')).error).not.toBeNull()
  expect((await anon.from('agenda_item_notes').select('item_id')).error).not.toBeNull()
})
