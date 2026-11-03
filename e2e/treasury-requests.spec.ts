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
  await admin().from('treasury_settings').update({ member_access: false, approval_threshold_cents: 0 }).eq('singleton', true)
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
const today = () => new Date().toISOString().slice(0, 10)

test('a member donates, requests refunds over and under the limit, cancels one; the Treasurer pays, Command approves and rejects', async ({ browser }) => {
  await setAccess(true)
  const cmd = await seedUser('command', 'tqe-cmd')
  const mem = await seedUser('member', 'tqe-mem')
  const other = await seedUser('member', 'tqe-oth')
  const fundName = `Fake coffers ${uniq()}`

  // Synthetic setup through the API as the Treasurer: a fund, a $100.00 stored balance, a $50.00 limit.
  const c = await asUser(cmd.email, cmd.password)
  expect((await c.rpc('treasury_create_fund', { p_name: fundName })).error).toBeNull()
  expect(
    (await c.rpc('treasury_record', { p_date: today(), p_amount_cents: 10000, p_from_kind: 'external', p_from_id: null, p_to_kind: 'member', p_to_id: mem.id, p_category: 'deposit', p_note: 'Fake: sent ahead' })).error,
  ).toBeNull()
  expect((await c.rpc('set_treasury_approval_threshold', { p_cents: 5000 })).error).toBeNull()

  const pm = await signedInPage(browser, mem)
  await pm.goto('/treasury')
  await expect(pm.getByLabel('Available balance')).toHaveText('$100.00')

  // Donation applies immediately.
  await pm.getByLabel('Fund', { exact: true }).selectOption({ label: fundName })
  await pm.getByLabel('Gift amount (dollars)').fill('10')
  await pm.getByRole('button', { name: 'Give to fund' }).click()
  await expect(pm.getByText('Thank you. Your gift is in the ledger.')).toBeVisible()
  await expect(pm.getByLabel('Available balance')).toHaveText('$90.00')

  // A small refund request reserves its amount.
  await pm.getByLabel('Refund amount (dollars)').fill('30')
  await pm.getByLabel('Refund note').fill('Fake: event cancelled')
  await pm.getByRole('button', { name: 'Request refund' }).click()
  await expect(pm.getByLabel('Available balance')).toHaveText('$60.00')
  const small = pm.getByRole('listitem').filter({ hasText: mem.callsign }).filter({ hasText: '$30.00' })
  await expect(small.getByText('WITH THE TREASURER')).toBeVisible()

  // The warning for a request above the limit; then the request itself.
  await pm.getByLabel('Refund amount (dollars)').fill('55')
  await expect(pm.getByText('This one will.')).toBeVisible()
  await pm.getByLabel('Refund note').fill('Fake: large refund')
  await pm.getByRole('button', { name: 'Request refund' }).click()
  const big = pm.getByRole('listitem').filter({ hasText: mem.callsign }).filter({ hasText: '$55.00' })
  await expect(big.getByText('AWAITING COMMAND APPROVAL')).toBeVisible()
  await expect(pm.getByLabel('Available balance')).toHaveText('$5.00')

  // Reserved money cannot be requested again or given away.
  await pm.getByLabel('Refund amount (dollars)').fill('10')
  await pm.getByLabel('Refund note').fill('Fake: too much')
  await pm.getByRole('button', { name: 'Request refund' }).click()
  await expect(pm.getByText('That is more than you have available.')).toBeVisible()
  expect(await noSideScroll(pm)).toBe(true)

  // The requester has no staff controls, and can cancel their own pending request.
  await expect(big.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(big.getByRole('button', { name: 'Mark paid' })).toHaveCount(0)
  await small.getByRole('button', { name: 'Cancel request' }).click()
  await small.getByRole('button', { name: 'Confirm cancel' }).click()
  await expect(small.getByText('CANCELLED')).toBeVisible()
  await expect(pm.getByLabel('Available balance')).toHaveText('$35.00')

  // Another member sees none of it.
  const po = await signedInPage(browser, other)
  await po.goto('/treasury')
  await expect(po.getByText(mem.callsign)).toHaveCount(0)
  await expect(po.getByText('No requests.')).toBeVisible()
  await po.context().close()
  const o = await asUser(other.email, other.password)
  expect((await o.from('treasury_requests').select('id')).data).toHaveLength(0)

  // Command: the large request cannot be paid until approved; then it is paid with a reference.
  const pc = await signedInPage(browser, cmd)
  await pc.goto('/treasury')
  const cbig = pc.getByRole('listitem').filter({ hasText: mem.callsign }).filter({ hasText: '$55.00' })
  await expect(cbig.getByText('AWAITING COMMAND APPROVAL')).toBeVisible()
  await expect(cbig.getByRole('button', { name: 'Mark paid' })).toHaveCount(0)
  await cbig.getByRole('button', { name: 'Approve' }).click()
  await cbig.getByRole('button', { name: 'Confirm approval' }).click()
  await expect(cbig.getByText('WITH THE TREASURER')).toBeVisible()
  await cbig.getByRole('button', { name: 'Mark paid' }).click()
  await cbig.getByLabel('Payment reference').fill('Fake: bank ref 7')
  await cbig.getByRole('button', { name: 'Confirm paid' }).click()
  await expect(cbig.getByText('PAID')).toBeVisible()
  await expect(cbig.getByText(/Fake: bank ref 7/)).toBeVisible()
  expect(await noSideScroll(pc)).toBe(true)

  // The ledger holds the external withdrawal, and the member's balance is what is left.
  const entry = await admin().from('treasury_entries').select('amount_cents,category,to_kind').eq('from_member', mem.id).eq('category', 'refund')
  expect(entry.data).toEqual([{ amount_cents: 5500, category: 'refund', to_kind: 'external' }])
  await pm.reload()
  await expect(pm.getByLabel('Available balance')).toHaveText('$35.00')
  await pm.context().close()
  await pc.context().close()
})

test('Treasurer rejects with a reason; threshold, approver and payer rules hold at the API', async () => {
  await setAccess(true)
  const cmd = await seedUser('command', 'tqr-cmd')
  const cmd2 = await seedUser('command', 'tqr-cmd2')
  const mem = await seedUser('member', 'tqr-mem')
  const c = await asUser(cmd.email, cmd.password)
  const c2 = await asUser(cmd2.email, cmd2.password)
  const m = await asUser(mem.email, mem.password)
  expect((await c.rpc('set_treasury_approval_threshold', { p_cents: 1000 })).error).toBeNull()
  expect((await m.rpc('set_treasury_approval_threshold', { p_cents: 1 })).error?.message).toBe('not allowed')
  await c.rpc('treasury_record', { p_date: today(), p_amount_cents: 10000, p_from_kind: 'external', p_from_id: null, p_to_kind: 'member', p_to_id: mem.id, p_category: 'deposit', p_note: '' })
  await c2.rpc('treasury_record', { p_date: today(), p_amount_cents: 10000, p_from_kind: 'external', p_from_id: null, p_to_kind: 'member', p_to_id: cmd2.id, p_category: 'deposit', p_note: '' })

  // Reject frees the reservation.
  const r1 = await m.rpc('treasury_request_refund', { p_amount_cents: 800, p_note: 'Fake: small' })
  expect(r1.error).toBeNull()
  expect((await m.rpc('treasury_my_available')).data).toBe(9200)
  expect((await c.rpc('treasury_reject_request', { p_request: r1.data, p_reason: 'x' })).error?.message).toBe('bad_note')
  expect((await c.rpc('treasury_reject_request', { p_request: r1.data, p_reason: 'Fake: no paperwork' })).error).toBeNull()
  expect((await m.rpc('treasury_my_available')).data).toBe(10000)
  expect((await c.rpc('treasury_pay_request', { p_request: r1.data, p_paid_date: today(), p_reference: '' })).error?.message).toBe('not_pending')

  // Above the limit: the Treasurer cannot pay; a Command requester cannot approve or pay their own.
  const r2 = await m.rpc('treasury_request_refund', { p_amount_cents: 1001, p_note: 'Fake: over the limit' })
  expect((await c.rpc('treasury_pay_request', { p_request: r2.data, p_paid_date: today(), p_reference: '' })).error?.message).toBe('needs_approval')
  expect((await m.rpc('treasury_approve_request', { p_request: r2.data })).error?.message).toBe('not allowed')
  const r3 = await c2.rpc('treasury_request_refund', { p_amount_cents: 5000, p_note: 'Fake: Command member asks' })
  expect((await c2.rpc('treasury_approve_request', { p_request: r3.data })).error?.message).toBe('own_request')
  expect((await c2.rpc('treasury_pay_request', { p_request: r3.data, p_paid_date: today(), p_reference: '' })).error?.message).toBe('own_request')
  expect((await c.rpc('treasury_approve_request', { p_request: r3.data })).error).toBeNull()

  // Every state change is logged.
  const log = await admin().from('treasury_request_log').select('action').eq('request_id', r1.data).order('created_at')
  expect((log.data ?? []).map((l) => l.action)).toEqual(['requested', 'rejected'])
})
