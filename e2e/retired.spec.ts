import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, openSeatCaps, resetInviteAttempts, seedUser, setSeatCaps, tierId, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
// Seat tests count every Old Guard account, so each test starts from none of the previous test's accounts.
test.afterEach(async () => {
  await admin().from('member_designations').delete().not('profile_id', 'is', null)
  await cleanup()
  await openSeatCaps()
})
test.afterAll(async () => {
  await admin().from('traffic').delete().like('title', 'E2E %')
  await cleanup()
})

async function signIn(page: Page, u: SeededUser, landing: RegExp = /\/hq$/) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(landing)
}

const memberPage = (page: Page, u: SeededUser) => page.goto(`/roster/${encodeURIComponent(u.callsign)}`)

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
}

async function makeOldGuard(u: SeededUser) {
  const r = await admin().from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', u.id)
  expect(r.error).toBeNull()
}

test('Command retires a Member: the roster moves them to Retired, and they sign in to a limited home', async ({ page, browser }) => {
  const cmd = await seedUser('command', 'ret-cmd')
  const mem = await seedUser('member', 'ret-mem')
  await admin().from('traffic').insert({ title: 'E2E notice for retired', body: 'Plain traffic body' })

  await signIn(page, cmd)
  await memberPage(page, mem)
  await page.getByLabel('Reason (optional)').fill('e2e: moved on')
  await page.getByRole('button', { name: 'Retire member' }).click()
  await page.getByRole('button', { name: `Confirm: retire ${mem.callsign}` }).click()
  await expect(page.getByText('RETIRED', { exact: true })).toBeVisible()

  const row = await admin().from('profiles').select('status,retired_at,retired_from_tier,tier_id').eq('id', mem.id).single()
  expect(row.data).toMatchObject({ status: 'retired', retired_from_tier: await tierId('Member') })
  expect(row.data?.retired_at).toBeTruthy()

  // Roster: gone from the active table, present in the separate Retired section.
  await page.goto('/roster')
  const members = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Members', exact: true }) })
  await expect(members.getByRole('link', { name: mem.callsign })).toHaveCount(0)
  const retiredSection = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Retired \(/ }) })
  await expect(retiredSection.getByRole('link', { name: mem.callsign })).toBeVisible()

  // The audit feed shows who, what and the reason.
  await page.goto('/admin/audit')
  await expect(page.getByText('e2e: moved on')).toBeVisible()

  // The retired member signs in to the limited home, sees Traffic, and is sent back from everything else.
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await signIn(p2, mem, /\/retired$/)
  await expect(p2.getByRole('heading', { name: 'Retired', level: 1 })).toBeVisible()
  await expect(p2.getByText('E2E notice for retired')).toBeVisible()
  for (const path of ['/hq', '/roster', '/minutes', '/documents', '/designations', '/admin/members']) {
    await p2.goto(path)
    await expect(p2).toHaveURL(/\/retired$/)
  }
  await p2.goto('/traffic')
  await expect(p2).toHaveURL(/\/traffic$/)
  await expect(p2.getByRole('heading', { name: 'Traffic', level: 1 })).toBeVisible()
  await p2.goto('/notifications')
  await expect(p2.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible()
  await ctx.close()

  // And the database agrees: own row yes; private details, event details and minutes no.
  const asRetired = await asUser(mem.email, mem.password)
  const own = await asRetired.from('profiles').select('id').eq('id', mem.id)
  expect(own.data).toHaveLength(1)
  // Their own private row stays theirs; nobody else's is readable.
  const others = await asRetired.from('member_private').select('profile_id').neq('profile_id', mem.id)
  expect(others.data ?? []).toHaveLength(0)
  for (const table of ['event_details', 'minutes', 'documents']) {
    const r = await asRetired.from(table).select('*')
    expect({ table, rows: r.data ?? [] }).toEqual({ table, rows: [] })
  }
  const rsvps = await asRetired.from('event_rsvps').select('*').neq('profile_id', mem.id)
  expect(rsvps.data ?? []).toHaveLength(0)
  const refused = await asRetired.rpc('retire_member', { p_profile: cmd.id, p_reason: null })
  expect(refused.error).not.toBeNull()
})

test('retiring an Old Guard member frees the seat, lists their designations first, and return is refused while the seat is full', async ({ page }) => {
  const cmd = await seedUser('command', 'ret-seat-cmd')
  const og = await seedUser('member', 'ret-seat-og')
  const next = await seedUser('member', 'ret-seat-next')
  await makeOldGuard(og)
  const treasurer = await admin().from('designations').select('id').eq('name', 'Treasurer').single()
  expect((await admin().from('member_designations').insert({ profile_id: og.id, designation_id: treasurer.data!.id })).error).toBeNull()
  // Command + this Old Guard member fill an Old Guard cap of 2.
  await setSeatCaps(2, 1)

  const asCmd = await asUser(cmd.email, cmd.password)
  const full = await asCmd.from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', next.id)
  expect(full.error?.message).toContain('Old Guard is full')

  await signIn(page, cmd)
  await memberPage(page, og)
  // The warning names what will be vacated before anything is confirmed.
  await expect(page.getByText(/will lose these designations and office seats.*Treasurer/)).toBeVisible()
  await page.getByRole('button', { name: 'Retire member' }).click()
  await page.getByRole('button', { name: `Confirm: retire ${og.callsign}` }).click()
  await expect(page.getByRole('heading', { name: 'Return to the roster' })).toBeVisible()
  const held = await admin().from('member_designations').select('profile_id').eq('profile_id', og.id)
  expect(held.data).toHaveLength(0)

  // The freed seat takes a promotion at the cap.
  const ok = await asCmd.from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', next.id)
  expect(ok.error).toBeNull()

  // Old Guard is full again, so returning to the prior seat is refused and Command picks another tier.
  await page.reload()
  await page.getByRole('button', { name: 'Return to roster' }).click()
  await page.getByRole('button', { name: `Confirm: return ${og.callsign}` }).click()
  await expect(page.getByRole('alert')).toContainText('Old Guard is full')
  await page.getByLabel('Return as').selectOption({ label: 'Member' })
  await page.getByRole('button', { name: 'Return in this tier' }).click()
  await expect(page.getByRole('heading', { name: 'Return to the roster' })).toHaveCount(0)

  const back = await admin().from('profiles').select('status,tier_id,retired_at').eq('id', og.id).single()
  expect(back.data).toMatchObject({ status: 'approved', tier_id: await tierId('Member'), retired_at: null })
  const held2 = await admin().from('member_designations').select('profile_id').eq('profile_id', og.id)
  expect(held2.data).toHaveLength(0)
})

test('a plain Member is offered no retire action and the RPC refuses them', async ({ page }) => {
  const a = await seedUser('member', 'ret-plain-a')
  const b = await seedUser('member', 'ret-plain-b')
  await signIn(page, a)
  await memberPage(page, b)
  await expect(page.getByRole('heading', { name: 'Retire member' })).toHaveCount(0)
  const asA = await asUser(a.email, a.password)
  const r = await asA.rpc('retire_member', { p_profile: b.id, p_reason: null })
  expect(r.error?.message).toBe('not allowed')
  await signOut(page)
})
