import { expect, test, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, openSeatCaps, resetInviteAttempts, seedUser, setSeatCaps, tierId } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterEach(async () => {
  await openSeatCaps()
})
test.afterAll(async () => {
  await admin().from('settings_audit').delete().eq('event', 'seat_caps_changed')
  await cleanup()
  await openSeatCaps()
})

async function signIn(page: Page, u: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

/** Approved accounts holding a seat right now (what the database counts). */
async function tallies() {
  const og = await tierId('Old Guard')
  const cm = await tierId('Command')
  const rows = await admin().from('profiles').select('tier_id').in('status', ['approved', 'suspended']).in('tier_id', [og, cm])
  const ids = (rows.data ?? []).map((r: { tier_id: string }) => r.tier_id)
  return { oldGuard: ids.length, command: ids.filter((t) => t === cm).length }
}

test('promote until full, blocked with a clear message, demote, promote again', async ({ page }) => {
  const cmd = await seedUser('command', 'seat-cmd')
  const m1 = await seedUser('member', 'seat-m1')
  const m2 = await seedUser('member', 'seat-m2')
  const t = await tallies()
  const ogCap = t.oldGuard + 1
  await setSeatCaps(ogCap, Math.min(t.command, ogCap))

  await signIn(page, cmd)
  await page.goto('/admin/members')
  const tierOf = async (id: string) => (await admin().from('profiles').select('tier_id').eq('id', id).single()).data?.tier_id
  const og = await tierId('Old Guard')
  const member = await tierId('Member')

  // One seat free: the first promotion goes through and fills Old Guard.
  await page.getByLabel(`Tier for ${m1.callsign}`).selectOption({ label: 'Old Guard' })
  await expect.poll(() => tierOf(m1.id)).toBe(og)

  // Full: the second is refused with the database's own message, and nothing moves.
  await page.getByLabel(`Tier for ${m2.callsign}`).selectOption({ label: 'Old Guard' })
  await expect(page.getByRole('alert')).toContainText(`Old Guard is full: ${ogCap}/${ogCap}`)
  expect(await tierOf(m2.id)).toBe(member)

  // The roster shows the counters and no vacancy.
  await page.goto('/roster')
  await expect(page.getByText(`Old Guard ${ogCap}/${ogCap}, Command ${t.command}/${Math.min(t.command, ogCap)}`)).toBeVisible()
  await expect(page.getByText(/Vacant: Old Guard 0/)).toBeVisible()

  // Demotion frees the seat at once.
  await page.goto('/admin/members')
  await page.getByLabel(`Tier for ${m1.callsign}`).selectOption({ label: 'Member' })
  await expect.poll(() => tierOf(m1.id)).toBe(member)
  await page.getByLabel(`Tier for ${m2.callsign}`).selectOption({ label: 'Old Guard' })
  await expect.poll(() => tierOf(m2.id)).toBe(og)
})

test('two simultaneous promotions into the last Command seat: exactly one succeeds', async () => {
  const cmd = await seedUser('command', 'seat-race-cmd')
  const b = await seedUser('member', 'seat-race-b')
  const c = await seedUser('member', 'seat-race-c')
  const ogId = await tierId('Old Guard')
  const cmId = await tierId('Command')
  for (const u of [b, c]) {
    expect((await admin().from('profiles').update({ tier_id: ogId }).eq('id', u.id)).error).toBeNull()
  }
  const t = await tallies()
  await setSeatCaps(99, t.command + 1) // exactly one Command seat free

  const as = await asUser(cmd.email, cmd.password)
  const results = await Promise.all(
    [b, c].map((u) => as.from('profiles').update({ tier_id: cmId }).eq('id', u.id)),
  )
  const failed = results.filter((r) => r.error)
  expect(failed).toHaveLength(1)
  expect(failed[0].error?.message).toMatch(/Command is full/)
  const after = await tallies()
  expect(after.command).toBe(t.command + 1)
})

test('Admin changes the caps from the Tiers screen; it is logged and a plain Member is refused', async ({ page }) => {
  const boss = await seedUser('admin', 'seat-admin')
  const mem = await seedUser('member', 'seat-plain')
  await signIn(page, boss)
  await page.goto('/admin/tiers')
  // The fields are disabled until the current caps have loaded; wait so the load cannot overwrite what is typed.
  await expect(page.getByLabel('Old Guard cap (Command included)')).toBeEnabled()
  await expect(page.getByLabel('Old Guard cap (Command included)')).not.toHaveValue('')
  await page.getByLabel('Old Guard cap (Command included)').fill('7')
  await page.getByLabel('Command cap').fill('9')
  await page.getByRole('button', { name: 'Save caps' }).click()
  await expect(page.getByRole('alert')).toContainText('cannot be higher')
  await page.getByLabel('Command cap').fill('2')
  await page.getByRole('button', { name: 'Save caps' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  const caps = await admin().from('seat_caps').select('old_guard_max,command_max,updated_by').single()
  expect(caps.data).toEqual({ old_guard_max: 7, command_max: 2, updated_by: boss.id })
  const log = await admin().from('settings_audit').select('actor_id,detail').eq('event', 'seat_caps_changed')
  expect(log.data).toHaveLength(1)
  expect(log.data?.[0].actor_id).toBe(boss.id)
  expect(log.data?.[0].detail).toMatch(/-> 7, command \d+ -> 2$/)

  const asMem = await asUser(mem.email, mem.password)
  expect((await asMem.rpc('set_seat_caps', { p_old_guard_max: 50, p_command_max: 5 })).error).not.toBeNull()
  expect((await asMem.rpc('seat_counts')).error).not.toBeNull()
  const still = await admin().from('seat_caps').select('old_guard_max').single()
  expect(still.data?.old_guard_max).toBe(7)
})
