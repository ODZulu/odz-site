import { defineConfig, devices } from '@playwright/test'

/**
 * Tier 2 (MVA-205). Backend-dependent suites need E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY and
 * E2E_SUPABASE_SERVICE_KEY from a LOCAL Supabase stack (`supabase start`); without them those
 * suites skip and only the UI-only suites run. Never point this at the prod project. See docs/TESTING.md.
 *
 * E2E_CHANNEL=chrome uses the installed Chrome instead of the downloaded Chromium.
 */
const channel = process.env.E2E_CHANNEL || undefined
const url = process.env.E2E_SUPABASE_URL ?? ''
const anon = process.env.E2E_SUPABASE_ANON_KEY ?? ''
const port = 5173

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Backend suites share one database and one rate-limit bucket; run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  // Artifacts are fake data only (the helpers enforce it) and are never committed.
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Process env wins over .env.local, so a developer's real dev-project values never leak into e2e.
    env: { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: anon },
  },
})
