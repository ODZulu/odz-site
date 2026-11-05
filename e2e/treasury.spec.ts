import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, uniq } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

const setAccess = async (on: boolean) => {
  const r = await admin().from('treasury_settings').update({ member_access: on }).eq('singleton', true)
  expect(r.error).toBeNull()
}

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  // The module ships dark; leave it that way for every other suite.
  await setAccess(false)
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

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('dark ship: only an Admin can open the treasury until the switch is flipped; the banner is always shown', async ({ browser }) => {
  await setAccess(false)
  const boss = await seedUser('admin', 'tr-adm')
  const cmd = await seedUser('command', 'tr-cmd')
  const mem = await seedUser('member', 'tr-mem')

  const pa = await signedInPage(browser, boss)
  await pa.goto('/treasury')
  await expect(pa.getByText('Tracking only. Real money is held by banks.')).toBeVisible()
  await expect(pa.getByRole('heading', { name: 'Your stored balance' })).toBeVisible()
  await expect(pa.getByRole('link', { name: 'TREASURY' })).toBeVisible()
  expect(await noSideScroll(pa)).toBe(true)
  await pa.context().close()

  for (const u of [cmd, mem]) {
    const p = await signedInPage(browser, u)
    await p.goto('/treasury')
    await expect(p.getByText('Tracking only. Real money is held by banks.')).toBeVisible()
    await expect(p.getByText('The treasury is not open yet.')).toBeVisible()
    await expect(p.getByRole('link', { name: 'TREASURY' })).toHaveCount(0)
    await p.context().close()
  }

  // The API agrees: nothing is readable or writable by anyone but the Admin while dark.
  const c = await asUser(cmd.email, cmd.password)
  expect((await c.from('treasury_funds').select('id')).data).toHaveLength(0)
  expect((await c.rpc('treasury_create_fund', { p_name: `Fake ${uniq()}` })).error?.message).toBe('not allowed')
  expect((await (await asUser()).rpc('treasury_access')).error).not.toBeNull()
})

test('the Treasurer records, refuses an overdraft and reverses; a member sees only their own entries; Old Guard sees everything', async ({ browser }) => {
  await setAccess(true)
  const cmd = await seedUser('command', 'trl-cmd')
  const mem = await seedUser('member', 'trl-mem')
  const other = await seedUser('member', 'trl-oth')
  const fund = `Fake gear ${uniq()}`

  const pt = await signedInPage(browser, cmd)
  await pt.goto('/treasury')
  await expect(pt.getByText('Tracking only. Real money is held by banks.')).toBeVisible()

  // New fund.
  await pt.getByLabel('New fund name').fill(fund)
  await pt.getByRole('button', { name: 'Add fund' }).click()
  await expect(pt.getByRole('cell', { name: fund }).first()).toBeVisible()

  // Deposit $50.00 to the member.
  await pt.getByLabel('Amount (dollars)', { exact: true }).fill('50')
  await pt.getByLabel('To', { exact: true }).selectOption({ label: `Member: ${mem.callsign}` })
  await pt.getByLabel('Entry note').fill('Fake: sent ahead')
  await pt.getByRole('button', { name: 'Record entry' }).click()
  await expect(pt.getByRole('row').filter({ hasText: mem.callsign }).filter({ hasText: '$50.00' }).filter({ hasText: 'deposit' })).toBeVisible()
  await expect(pt.getByText('RECONCILES')).toBeVisible()

  // Other member gets $5.00 (to prove they are hidden from the first).
  await pt.getByLabel('Amount (dollars)', { exact: true }).fill('5.00')
  await pt.getByLabel('To', { exact: true }).selectOption({ label: `Member: ${other.callsign}` })
  await pt.getByRole('button', { name: 'Record entry' }).click()
  await expect(pt.getByRole('row').filter({ hasText: other.callsign }).filter({ hasText: '$5.00' }).filter({ hasText: 'deposit' })).toBeVisible()

  // Overdraft: $60 out of a $50 balance is refused.
  await pt.getByLabel('Amount (dollars)', { exact: true }).fill('60')
  await pt.getByLabel('From', { exact: true }).selectOption({ label: `Member: ${mem.callsign}` })
  await pt.getByLabel('To', { exact: true }).selectOption({ label: 'Outside (bank, cash)' })
  await pt.getByLabel('Entry category').selectOption('withdrawal')
  await pt.getByRole('button', { name: 'Record entry' }).click()
  await expect(pt.getByText('That would take a balance below zero, so it was refused.')).toBeVisible()
  expect(await noSideScroll(pt)).toBe(true)

  // Reverse the $5.00 deposit (requires a reason).
  const row = pt.getByRole('row').filter({ hasText: other.callsign }).filter({ hasText: '$5.00' }).filter({ hasText: 'deposit' })
  await row.getByRole('button', { name: /Reverse entry/ }).click()
  await pt.getByLabel('Reason (required)').fill('Fake: entered in error')
  await pt.getByRole('button', { name: 'Reverse', exact: true }).click()
  await pt.getByRole('button', { name: 'Confirm reversal' }).click()
  await expect(row.getByText('(reversed)')).toBeVisible()
  await expect(pt.getByRole('row').filter({ hasText: other.callsign }).filter({ hasText: '(reverses an entry)' })).toBeVisible()

  // CSV export is offered to the Treasurer.
  const download = pt.waitForEvent('download')
  await pt.getByRole('button', { name: 'Export CSV' }).click()
  expect((await download).suggestedFilename()).toBe('treasury-ledger.csv')

  // The member sees their own balance and entries only, and no controls.
  const pm = await signedInPage(browser, mem)
  await pm.goto('/treasury')
  await expect(pm.getByLabel('Your stored balance')).toHaveText('$50.00')
  await expect(pm.getByRole('cell', { name: 'Outside' }).first()).toBeVisible()
  await expect(pm.getByText(other.callsign)).toHaveCount(0)
  await expect(pm.getByRole('button', { name: 'Record entry' })).toHaveCount(0)
  await expect(pm.getByRole('button', { name: 'Export CSV' })).toHaveCount(0)
  await expect(pm.getByRole('heading', { name: 'Team coffers' })).toHaveCount(0)
  expect(await noSideScroll(pm)).toBe(true)
  await pm.context().close()

  // The API agrees.
  const m = await asUser(mem.email, mem.password)
  const own = await m.from('treasury_entries').select('to_member,from_member')
  expect((own.data ?? []).every((e) => e.to_member === mem.id || e.from_member === mem.id)).toBe(true)
  expect((await m.rpc('treasury_balances')).error?.message).toBe('not allowed')
  expect((await m.rpc('treasury_record', { p_date: new Date().toISOString().slice(0, 10), p_amount_cents: 100, p_from_kind: 'external', p_from_id: null, p_to_kind: 'member', p_to_id: mem.id, p_category: 'deposit', p_note: '' })).error?.message).toBe('not allowed')

  // Old Guard (read only) sees the whole ledger by name but cannot write.
  const og = await seedUser('member', 'trl-og')
  const up = await admin().from('profiles').update({ tier_id: (await admin().from('tiers').select('id').eq('name', 'Old Guard').single()).data?.id }).eq('id', og.id)
  expect(up.error).toBeNull()
  const po = await signedInPage(browser, og)
  await po.goto('/treasury')
  await expect(po.getByRole('heading', { name: 'Team coffers' })).toBeVisible()
  await expect(po.getByRole('cell', { name: other.callsign }).first()).toBeVisible()
  await expect(po.getByRole('button', { name: 'Record entry' })).toHaveCount(0)
  await po.context().close()
  await pt.context().close()
})

test('Admin switches member access on and off from the Treasury page; non-Admin never sees the control (MVA-255)', async ({ browser }) => {
  await setAccess(false)
  const boss = await seedUser('admin', 'tra-adm')
  const cmd = await seedUser('command', 'tra-cmd')
  const mem = await seedUser('member', 'tra-mem')
  await admin().from('treasury_settings').update({ approval_threshold_cents: 0 }).eq('singleton', true)

  const pa = await signedInPage(browser, boss)
  await pa.goto('/treasury')
  await expect(pa.getByRole('heading', { name: 'Member access' })).toBeVisible()
  await expect(pa.getByLabel('Member access state')).toContainText('Only Admins can use the treasury')
  await expect(pa.getByText('every refund needs Command approval')).toBeVisible()
  expect(await noSideScroll(pa)).toBe(true)

  // Members cannot get in while it is off.
  const pm = await signedInPage(browser, mem)
  await pm.goto('/treasury')
  await expect(pm.getByText('The treasury is not open yet.')).toBeVisible()

  await pa.getByRole('button', { name: 'Turn member access on' }).click()
  await expect(pa.getByLabel('Member access state')).toContainText('Members can see their own entries')
  await pm.reload()
  await expect(pm.getByRole('heading', { name: 'Your stored balance' })).toBeVisible()
  await expect(pm.getByRole('heading', { name: 'Member access' })).toHaveCount(0)

  // Turning it off asks first and explains the loss.
  await expect(pa.getByText('members lose their balance')).toBeVisible()
  await pa.getByRole('button', { name: 'Turn member access off' }).click()
  await pa.getByRole('button', { name: 'Confirm: turn off' }).click()
  await expect(pa.getByLabel('Member access state')).toContainText('Only Admins can use the treasury')
  await pm.reload()
  await expect(pm.getByText('The treasury is not open yet.')).toBeVisible()

  // Both changes are in the audit log, and the API refuses non-Admins.
  const audit = await admin().from('settings_audit').select('detail').eq('event', 'treasury_member_access_changed').eq('actor_id', boss.id)
  expect((audit.data ?? []).map((r) => r.detail).sort()).toEqual(['false -> true', 'true -> false'])
  await setAccess(true)
  const c = await asUser(cmd.email, cmd.password)
  expect((await c.rpc('treasury_member_access')).data).toBeNull()
  expect((await c.rpc('set_treasury_member_access', { p_on: false })).error?.message).toBe('not allowed')
  await pa.context().close()
  await pm.context().close()
})
