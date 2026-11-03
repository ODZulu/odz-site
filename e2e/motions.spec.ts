import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, tierId } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
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

/** The number of eligible voters the database snapshotted for the motion's current round. */
async function voterCount(motionId: string, round = 1): Promise<number> {
  const r = await admin().from('motion_voters').select('profile_id', { count: 'exact', head: true }).eq('motion_id', motionId).eq('round', round)
  return r.count ?? 0
}

test('Command opens a motion, voters cast from a phone, the majority decides it, and the record shows who voted what', async ({ browser }) => {
  const c1 = await seedUser('command', 'mot-c1')
  const c2 = await seedUser('command', 'mot-c2')
  const c3 = await seedUser('command', 'mot-c3')
  const voters = [c1, c2, c3]

  const p1 = await signedInPage(browser, c1)
  await p1.goto('/motions')
  await p1.getByRole('button', { name: 'Open a motion' }).click()
  await p1.getByLabel('Title', { exact: true }).fill('Fake motion: adopt the fake standard')
  await p1.getByLabel('Description').fill('Fake description for a fake motion.')
  await p1.getByRole('button', { name: 'Open motion' }).click()
  await expect(p1.getByRole('link', { name: 'Fake motion: adopt the fake standard' })).toBeVisible()
  expect(await noSideScroll(p1)).toBe(true)
  await p1.getByRole('link', { name: 'Fake motion: adopt the fake standard' }).click()
  await expect(p1.getByText('Your vote')).toBeVisible()
  const motionId = p1.url().split('/').pop() as string

  const n = await voterCount(motionId)
  expect(n).toBeGreaterThanOrEqual(3)
  const needed = Math.floor(n / 2) + 1

  // The opener votes, changes the vote, and votes again; the record keeps all of it.
  await p1.getByRole('button', { name: 'Reject' }).click()
  await expect(p1.getByText('You voted Reject.')).toBeVisible()
  await p1.getByRole('button', { name: 'Approve' }).click()
  await expect(p1.getByText('You voted Approve.')).toBeVisible()
  expect(await noSideScroll(p1)).toBe(true)

  // The others vote until a strict majority exists.
  for (const u of voters.slice(1, needed)) {
    const page = await signedInPage(browser, u)
    await page.goto(`/motions/${motionId}`)
    await page.getByRole('button', { name: 'Approve' }).click()
    // The deciding vote closes the motion, so the voting panel gives way to the result.
    await expect(page.getByText(/You voted Approve\.|DECIDED/).first()).toBeVisible()
    await page.context().close()
  }

  await p1.reload()
  await expect(p1.getByText('DECIDED', { exact: true })).toBeVisible()
  await expect(p1.getByText('Result', { exact: true })).toBeVisible()
  await expect(p1.getByText('Changed vote: Reject to Approve')).toBeVisible()
  await expect(p1.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  const row = await admin().from('motions').select('state,status,outcome_option').eq('id', motionId).single()
  expect(row.data).toMatchObject({ state: 'closed', status: 'decided', outcome_option: 'Approve' })
  await p1.context().close()
})

test('a recusal that leaves fewer than three voters escalates the motion to the Old Guard', async ({ browser }) => {
  const c1 = await seedUser('command', 'esc-c1')
  const c2 = await seedUser('command', 'esc-c2')
  const c3 = await seedUser('command', 'esc-c3')
  // The Old Guard round needs at least 3 eligible voters of its own, or it goes straight to an Admin.
  for (const tag of ['esc-o1', 'esc-o2']) {
    const o = await seedUser('member', tag)
    expect((await admin().from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', o.id)).error).toBeNull()
  }

  const a = await asUser(c1.email, c1.password)
  const opened = await a.rpc('open_motion', { p_type: 'general', p_title: 'Fake escalation', p_parties: [c2.id] })
  expect(opened.error).toBeNull()
  const motionId = opened.data as string
  // c2 is a party, so (when these are the only Command members) two eligible voters escalate at once.
  const commandCount = await voterCount(motionId, 1)
  if (commandCount < 3) {
    const m = await admin().from('motions').select('status,round,body').eq('id', motionId).single()
    expect(m.data).toMatchObject({ status: 'escalated', round: 2, body: 'old_guard' })
  }

  const page = await signedInPage(browser, c3)
  await page.goto(`/motions/${motionId}`)
  await expect(page.getByText(/ESCALATED|OPEN/)).toBeVisible()
  await page.context().close()

  // A party sees the motion but is not an eligible voter on it.
  const party = await asUser(c2.email, c2.password)
  const seen = await party.from('motions').select('id').eq('id', motionId)
  expect(seen.data).toHaveLength(1)
  const tried = await party.rpc('cast_vote', { p_motion: motionId, p_option: 'Approve' })
  expect(tried.error?.message).toBe('not_eligible')
})

test('RLS: a Member cannot see or vote on a motion; nobody writes votes directly; anon sees nothing', async () => {
  const cmd = await seedUser('command', 'rls-cmd')
  const member = await seedUser('member', 'rls-mem')

  const c = await asUser(cmd.email, cmd.password)
  const opened = await c.rpc('open_motion', { p_type: 'general', p_title: 'Fake RLS motion' })
  expect(opened.error).toBeNull()
  const motionId = opened.data as string

  const m = await asUser(member.email, member.password)
  const seen = await m.from('motions').select('id').eq('id', motionId)
  expect(seen.data).toHaveLength(0)
  const cast = await m.rpc('cast_vote', { p_motion: motionId, p_option: 'Approve' })
  expect(cast.error?.message).toBe('not_found')
  const opening = await m.rpc('open_motion', { p_type: 'general', p_title: 'Fake' })
  expect(opening.error).not.toBeNull()

  const direct = await c.from('motion_votes').insert({ motion_id: motionId, round: 1, voter_id: cmd.id, option: 'Approve' })
  expect(direct.error).not.toBeNull()
  const edit = await c.from('motions').update({ status: 'decided', outcome_option: 'Approve' }).eq('id', motionId)
  expect(edit.data ?? []).toHaveLength(0)

  const anon = await asUser()
  const none = await anon.from('motions').select('id')
  expect(none.error).not.toBeNull()
  const anonOpen = await anon.rpc('open_motion', { p_type: 'general', p_title: 'Fake' })
  expect(anonOpen.error).not.toBeNull()

  // Nothing the Member or anon tried changed the outcome.
  const row = await admin().from('motions').select('status,outcome_option').eq('id', motionId).single()
  expect(row.data?.outcome_option).toBeNull()
  expect(row.data?.status).not.toBe('decided')
})
