import { expect, test, type Page } from '@playwright/test'
import { admin, cleanup, hasBackend, resetInviteAttempts, seedUser, type SeededUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  const a = admin()
  const { data } = await a.from('minutes').select('id, files:minutes_files(storage_path)').like('title', 'E2E %')
  const paths = (data ?? []).flatMap((m: { files: Array<{ storage_path: string }> }) => m.files.map((f) => f.storage_path))
  if (paths.length) await a.storage.from('minutes').remove(paths)
  await a.from('minutes').delete().like('title', 'E2E %')
  await a.from('documents').delete().like('title', 'E2E %')
  await cleanup()
})

async function signIn(page: Page, u: SeededUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
}

const FAKE_PDF = Buffer.from('%PDF-1.4\n% e2e fake file, no real content\n')

test('a Recruit gets nothing from minutes or documents', async ({ page }) => {
  await signIn(page, await seedUser('recruit', 'arc-rec'))
  await expect(page.getByRole('link', { name: 'MINUTES' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'DOCS' })).toHaveCount(0)
  for (const path of ['/minutes', '/documents', '/minutes/new', '/documents/new']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/hq$/)
  }
})

test('Command writes minutes with a file; the draft is hidden, the published one opens; a script is inert', async ({ page, browser }) => {
  const cmd = await seedUser('command', 'arc-cmd')
  const mem = await seedUser('member', 'arc-mem')

  await signIn(page, cmd)
  await page.goto('/minutes/new')
  await page.getByLabel('Title').fill('E2E Weekly Sync')
  await page.getByLabel('Meeting date').fill('2026-10-01')
  await page.getByLabel('Notes (markdown)').fill('# Agenda\n\n<script>window.__pwned = 1</script>\n\n- item one')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page).toHaveURL(/\/minutes\/[0-9a-f-]+\/edit$/)

  // A disguised executable is refused before upload; a real-looking PDF is accepted.
  await page.locator('#upload-files').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ\x90\x00 not a pdf') })
  await expect(page.getByRole('status').filter({ hasText: 'do not match' })).toBeVisible()
  await page.locator('#upload-files').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: FAKE_PDF })
  await expect(page.getByText('notes.pdf')).toBeVisible()

  // Draft: a member sees nothing yet.
  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  await signIn(memberPage, mem)
  await memberPage.goto('/minutes')
  await expect(memberPage.getByText('E2E Weekly Sync')).toHaveCount(0)

  // Publish.
  await page.getByLabel('State').selectOption('published')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()

  await memberPage.goto('/minutes')
  await memberPage.getByRole('link', { name: 'E2E Weekly Sync' }).click()
  await expect(memberPage.locator('.odz-md')).toContainText('<script>')
  expect(await memberPage.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await expect(memberPage.getByText('notes.pdf')).toBeVisible()
  await memberCtx.close()
})

test('stored files are not reachable without a signed link', async ({ request }) => {
  const a = admin()
  const created = await a.from('minutes').insert({ title: 'E2E Private File', meeting_date: '2026-10-01', status: 'published' }).select('id').single()
  const id = (created.data as { id: string }).id
  const path = `${id}/00000000-0000-4000-8000-000000000001-secret.pdf`
  const up = await a.storage.from('minutes').upload(path, FAKE_PDF, { contentType: 'application/pdf' })
  expect(up.error).toBeNull()

  const base = process.env.E2E_SUPABASE_URL as string
  const publicUrl = await request.get(`${base}/storage/v1/object/public/minutes/${path}`)
  expect(publicUrl.ok()).toBe(false)
  const anon = await request.get(`${base}/storage/v1/object/authenticated/minutes/${path}`, {
    headers: { apikey: process.env.E2E_SUPABASE_ANON_KEY as string },
  })
  expect(anon.ok()).toBe(false)
})

test('documents: drafts stay hidden, ratifying a new version supersedes the old one', async ({ page, browser }) => {
  const cmd = await seedUser('command', 'doc-cmd')
  const mem = await seedUser('member', 'doc-mem')
  await signIn(page, cmd)

  async function create(version: string, status: string) {
    await page.goto('/documents/new')
    await page.getByLabel('Title', { exact: true }).fill('E2E Fake Bylaws')
    await page.getByLabel('Version').fill(version)
    await page.getByLabel('Type').selectOption('Bylaws')
    await page.getByLabel('Status').selectOption(status)
    await page.getByLabel('Text (markdown)').fill(`# Fake ${version}\n\nsome text`)
    if (status !== 'draft') await page.getByLabel('Visible to members').check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/edit\/[0-9a-f-]+$/)
  }

  await create('1.0', 'draft')
  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  await signIn(memberPage, mem)
  await memberPage.goto('/documents')
  await expect(memberPage.getByText('E2E Fake Bylaws')).toHaveCount(0)

  await create('1.1', 'ratified')
  await memberPage.goto('/documents')
  await expect(memberPage.getByText('E2E Fake Bylaws')).toBeVisible()
  await expect(memberPage.getByText('RATIFIED')).toBeVisible()

  await create('1.2', 'ratified')
  await memberPage.goto('/documents/e2e-fake-bylaws')
  await expect(memberPage.getByText('v1.2')).toHaveCount(0) // not listed until the toggle is opened
  await memberPage.getByRole('button', { name: /Show/ }).click()
  await expect(memberPage.getByText('SUPERSEDED')).toBeVisible()
  await memberCtx.close()
})
