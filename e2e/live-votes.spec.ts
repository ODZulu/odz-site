import { expect, test, type Browser, type Page } from '@playwright/test'
import { admin, asUser, cleanup, hasBackend, resetInviteAttempts, seedUser, tierId, uniq } from './helpers/backend'

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

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/** An Old Guard member (promoted from a seeded Member). */
async function oldGuard(tag: string) {
  const u = await seedUser('member', tag)
  const r = await admin().from('profiles').update({ tier_id: await tierId('Old Guard') }).eq('id', u.id)
  expect(r.error).toBeNull()
  return u
}

/** A published agenda with one vote item, built through the API as the chair. */
async function votingMeeting(chair: { email: string; password: string }) {
  const start = new Date(Date.now() + 2 * 86_400_000)
  const ev = await admin()
    .from('events')
    .insert({ title: `E2E Meeting ${uniq()}`, event_type: 'Meeting', starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString() })
    .select('id')
    .single()
  expect(ev.error).toBeNull()
  const c = await asUser(chair.email, chair.password)
  const ag = await c.from('agendas').insert({ event_id: ev.data?.id }).select('id').single()
  expect(ag.error).toBeNull()
  const item = await c
    .from('agenda_items')
    .insert({ agenda_id: ag.data?.id, position: 1, title: 'Fake bylaw vote', kind: 'vote', vote_wording: 'Shall the fake bylaw be adopted as written?' })
    .select('id')
    .single()
  expect(item.error).toBeNull()
  expect((await c.rpc('publish_agenda', { p_agenda: ag.data?.id })).error).toBeNull()
  return { eventId: ev.data?.id as string, agendaId: ag.data?.id as string, itemId: item.data?.id as string, chairClient: c }
}

test('the chair opens a vote, voters cast from phones with choices hidden, the chair closes it, and the result is revealed by name and written into the minutes', async ({ browser }) => {
  const chair = await seedUser('command', 'lv-c1')
  const c2 = await seedUser('command', 'lv-c2')
  const o1 = await oldGuard('lv-o1')
  const o2 = await oldGuard('lv-o2')
  const consulted = await seedUser('member', 'lv-mem')
  const { eventId, agendaId, itemId, chairClient } = await votingMeeting(chair)

  const pc = await signedInPage(browser, chair)
  await pc.goto(`/agenda/${eventId}`)
  await expect(pc.getByText('NOT OPENED')).toBeVisible()
  await pc.getByRole('button', { name: 'Open vote' }).click()
  await expect(pc.getByText('VOTING OPEN')).toBeVisible()
  await expect(pc.getByText(/Choices are hidden until the chair closes the vote/)).toBeVisible()
  expect(await noSideScroll(pc)).toBe(true)

  const motion = await admin().from('motions').select('id,mode,body,options,deadline').eq('parent_id', itemId).single()
  expect(motion.data).toMatchObject({ mode: 'live', body: 'old_guard', deadline: null })
  const motionId = motion.data?.id as string

  // Voters cast: chair, c2 and o1 Yes; o2 No.
  await pc.getByRole('button', { name: 'Yes', exact: true }).first().click()
  await expect(pc.getByText('Your vote: Yes.')).toBeVisible()
  const votes: [typeof c2, string][] = [[c2, 'Yes'], [o1, 'Yes'], [o2, 'No']]
  for (const [u, choice] of votes) {
    const p = await signedInPage(browser, u)
    await p.goto(`/agenda/${eventId}`)
    await p.getByRole('button', { name: choice, exact: true }).first().click()
    await expect(p.getByText(`Your vote: ${choice}.`)).toBeVisible()
    // Hidden while open: no names, no tally on the page.
    await expect(p.getByText('Yes 3')).toHaveCount(0)
    expect(await noSideScroll(p)).toBe(true)
    await p.context().close()
  }

  // The consulted Member answers the advisory poll.
  const pm = await signedInPage(browser, consulted)
  await pm.goto(`/agenda/${eventId}`)
  await pm.getByRole('button', { name: 'Advisory No' }).click()
  await expect(pm.getByText(/you answered No/)).toBeVisible()
  await pm.context().close()

  // The API agrees: a voter reads only their own vote while it is open, the chair included.
  const ov = await asUser(o2.email, o2.password)
  expect((await ov.from('motion_votes').select('voter_id').eq('motion_id', motionId)).data).toHaveLength(1)
  expect((await chairClient.from('motion_votes').select('voter_id').eq('motion_id', motionId)).data).toHaveLength(1)
  const prog = await ov.rpc('live_vote_progress', { p_motion: motionId })
  expect(prog.data?.[0]).toMatchObject({ voted: 4, is_voter: true, my_vote: 'No' })

  // A majority does not close it: only the chair does.
  await pc.reload()
  await expect(pc.getByText('VOTING OPEN')).toBeVisible()
  await expect(pc.getByText(/4 of \d+ eligible voters have voted/)).toBeVisible()
  await pc.getByRole('button', { name: 'Close vote' }).click()
  await pc.getByRole('button', { name: 'Confirm close and reveal' }).click()
  await expect(pc.getByText('CLOSED', { exact: true })).toBeVisible()
  await expect(pc.getByText(/^Passed/)).toBeVisible()
  await expect(pc.getByText(`${o2.callsign}: No`)).toBeVisible()
  await expect(pc.getByText(`${c2.callsign}: Yes`)).toBeVisible()
  await expect(pc.getByText(/Advisory poll, not counted: Yes 0, No 1/)).toBeVisible()
  expect(await noSideScroll(pc)).toBe(true)

  // Revealed to every voter; immutable afterwards.
  expect((await ov.from('motion_votes').select('voter_id').eq('motion_id', motionId)).data).toHaveLength(4)
  expect((await ov.rpc('cast_vote', { p_motion: motionId, p_option: 'Yes' })).error?.message).toBe('motion_closed')
  expect((await chairClient.rpc('close_live_vote', { p_motion: motionId })).error?.message).toBe('motion_closed')

  // Minutes from the agenda carry the wording, the result and every vote by name.
  const mn = await chairClient.rpc('create_minutes_from_agenda', { p_agenda: agendaId })
  expect(mn.error).toBeNull()
  const body = (await admin().from('minutes').select('body_md').eq('id', mn.data).single()).data?.body_md as string
  expect(body).toContain('Shall the fake bylaw be adopted as written?')
  expect(body).toContain('**Result:** Passed')
  expect(body).toContain(`${o2.callsign}: No`)
  expect(body).toContain('Advisory poll (consulted members, not counted):** Yes 0, No 1, Abstain 0')
  await admin().from('minutes').delete().eq('id', mn.data)
  await pc.context().close()
})

test('RLS: only Old Guard and Command can cast a counted vote; Members and Recruits cannot; the chair can record a vote for a voter, flagged', async () => {
  const chair = await seedUser('command', 'lvr-c1')
  await seedUser('command', 'lvr-c2')
  const o1 = await oldGuard('lvr-o1')
  const member = await seedUser('member', 'lvr-mem')
  const recruit = await seedUser('recruit', 'lvr-rec')
  const { itemId, chairClient } = await votingMeeting(chair)

  expect((await (await asUser(member.email, member.password)).rpc('open_live_vote', { p_item: itemId })).error?.message).toBe('not allowed')
  const opened = await chairClient.rpc('open_live_vote', { p_item: itemId })
  expect(opened.error).toBeNull()
  const motionId = opened.data as string

  const m = await asUser(member.email, member.password)
  expect((await m.rpc('cast_vote', { p_motion: motionId, p_option: 'Yes' })).error?.message).toBe('not_eligible')
  const r = await asUser(recruit.email, recruit.password)
  expect((await r.rpc('cast_vote', { p_motion: motionId, p_option: 'Yes' })).error).not.toBeNull()
  expect((await r.from('motions').select('id').eq('id', motionId)).data).toHaveLength(0)
  expect((await (await asUser()).rpc('live_vote_progress', { p_motion: motionId })).error).not.toBeNull()

  // The chair records a vote for o1, flagged and with a required note; o1 cannot then change it.
  expect((await chairClient.rpc('record_vote_for', { p_motion: motionId, p_voter: o1.id, p_option: 'Yes', p_note: 'x' })).error?.message).toBe('bad_reason')
  const rec = await chairClient.rpc('record_vote_for', { p_motion: motionId, p_voter: o1.id, p_option: 'Yes', p_note: 'Fake: present, no phone' })
  expect(rec.error).toBeNull()
  const o = await asUser(o1.email, o1.password)
  expect((await o.rpc('cast_vote', { p_motion: motionId, p_option: 'No' })).error?.message).toBe('recorded_by_chair')
  const row = await admin().from('motion_votes').select('recorded_by,record_note,option').eq('motion_id', motionId).eq('voter_id', o1.id).single()
  expect(row.data).toMatchObject({ record_note: 'Fake: present, no phone', option: 'Yes' })
  expect(row.data?.recorded_by).not.toBeNull()

  // The wording is frozen once the vote is open.
  const edit = await chairClient.from('agenda_items').update({ vote_wording: 'Changed' }).eq('id', itemId)
  expect(edit.error?.message).toBe('wording_frozen')
})
