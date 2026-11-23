import { expect, type Locator, type Page } from '@playwright/test'

/** The calendar card for an event (MVA-301): one link, found by its exact title heading. */
export const eventCard = (page: Page, title: string): Locator =>
  page.locator('a.odz-event').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

/** List to page: open the calendar, click the event's card, and wait for its page. */
export async function openEvent(page: Page, title: string): Promise<Locator> {
  await page.goto('/calendar')
  await openEventFromList(page, title)
  return eventPage(page)
}

/** From a list that is already open (past events are inside a closed disclosure). */
export async function openEventFromList(page: Page, title: string): Promise<void> {
  await eventCard(page, title).first().click()
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
}

/** The event page's content area, for scoping assertions. */
export const eventPage = (page: Page): Locator => page.locator('main')
