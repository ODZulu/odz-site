import { expect, test, type Browser, type Page } from '@playwright/test'
import { cleanup, hasBackend, resetInviteAttempts, seedUser } from './helpers/backend'

test.skip(!hasBackend, 'needs a local Supabase stack (see docs/TESTING.md)')

test.beforeEach(async () => {
  await resetInviteAttempts()
})
test.afterAll(async () => {
  await cleanup()
})

// A map style with no tiles at all, served in place of OpenFreeMap's, so these tests never touch the
// network. It still makes a real MapLibre map (and needs WebGL), which is what is under test.
const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfd8dc' } }] }

async function commandPage(browser: Browser, u: { email: string; password: string }, tilesBlocked = false): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } })
  await ctx.route('https://tiles.openfreemap.org/**', (route) => (tilesBlocked ? route.abort() : route.fulfill({ json: BLANK_STYLE })))
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(u.email)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/hq$/)
  return page
}

const hasWebGL = (page: Page) =>
  page.evaluate(() => {
    const c = document.createElement('canvas')
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'))
  })

const num = async (page: Page, label: string) => Number(await page.getByLabel(label).inputValue())

test('tap the map to drop a pin, tap elsewhere to move it, drag it, remove it', async ({ browser }) => {
  const cmd = await seedUser('command', 'map-cmd')
  const page = await commandPage(browser, cmd)
  test.skip(!(await hasWebGL(page)), 'this browser has no WebGL')
  await page.goto('/calendar')
  await page.getByRole('link', { name: 'New event' }).click()
  const map = page.getByRole('application', { name: /Map\. Tap to drop the event pin/ })
  await expect(map).toBeVisible()
  await expect(map.locator('canvas')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByLabel('Event pin', { exact: true })).toHaveCount(0)

  // Tap the middle: the pin lands on the map's starting centre (Phoenix) and fills both fields.
  await map.click()
  await expect(page.getByLabel('Event pin', { exact: true })).toBeVisible()
  const lat1 = await num(page, 'Latitude')
  const lng1 = await num(page, 'Longitude')
  expect(Math.abs(lat1 - 33.4484)).toBeLessThan(0.1)
  expect(Math.abs(lng1 - -112.074)).toBeLessThan(0.1)

  // Tap somewhere else: the same pin moves and the fields follow.
  await map.click({ position: { x: 40, y: 40 } })
  await expect.poll(() => num(page, 'Latitude')).not.toBe(lat1)
  const lat2 = await num(page, 'Latitude')
  expect(lat2).toBeGreaterThan(lat1) // up on screen is north

  // Drag the pin down.
  const pin = page.getByLabel('Event pin', { exact: true })
  const box = (await pin.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 60, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => num(page, 'Latitude')).toBeLessThan(lat2)

  // Typing coordinates moves the pin too; Remove pin clears everything.
  await page.getByLabel('Latitude').fill('34.5')
  await page.getByLabel('Longitude').fill('-111.5')
  await expect(page.getByLabel('Event pin', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Remove pin' }).click()
  await expect(page.getByLabel('Latitude')).toHaveValue('')
  await expect(page.getByLabel('Longitude')).toHaveValue('')
  await expect(page.getByLabel('Event pin', { exact: true })).toHaveCount(0)
})

test('a saved pin shows a small map preview on the event page', async ({ browser }) => {
  const cmd = await seedUser('command', 'map-prev')
  const title = 'E2E Map Preview Event'
  const page = await commandPage(browser, cmd)
  test.skip(!(await hasWebGL(page)), 'this browser has no WebGL')
  await page.goto('/calendar')
  await page.getByRole('link', { name: 'New event' }).click()
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Starts (Phoenix time)').fill('2030-06-01T09:00')
  await page.getByLabel('Latitude').fill('33.45')
  await page.getByLabel('Longitude').fill('-112.07')
  await page.getByRole('button', { name: 'Save event' }).click()

  // MVA-301: the preview is on the event page itself, under "When and where".
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
  const where = page.locator('section').filter({ has: page.getByRole('heading', { name: 'When and where' }) })
  await expect(where.getByText('Coordinates 33.45, -112.07')).toBeVisible()
  const preview = where.getByRole('img', { name: 'Map showing the event location' })
  await expect(preview.locator('canvas')).toBeVisible()
  await expect(where.getByLabel('Event pin', { exact: true })).toBeVisible()
})

// MVA-258: a blocked or offline tile host must never leave a silent white box. Tier 2 cannot see
// tiles, so this asserts only the message and that the coordinate fields still work.
test('a map that cannot load says so, and the latitude and longitude fields still work', async ({ browser }) => {
  const cmd = await seedUser('command', 'map-blocked')
  const page = await commandPage(browser, cmd, true)
  test.skip(!(await hasWebGL(page)), 'this browser has no WebGL')
  await page.goto('/calendar')
  await page.getByRole('link', { name: 'New event' }).click()
  await expect(page.getByRole('status').filter({ hasText: /The map could not load/ })).toBeVisible()
  await page.getByLabel('Latitude').fill('33.45')
  await page.getByLabel('Longitude').fill('-112.07')
  await expect(page.getByText('Pin set at 33.45, -112.07.')).toBeVisible()
})
