# ODZ web platform (odz-site)

Mothership Ventures LLC project. LORD writes specs, OPR (Claude Code) builds to them, Dax approves scope and signs GO/NO-GO. Process lives in Linear: "ODZ - Development SOP" and "ODZ - Playbook" (project ODZ, team MV Admin, prefix MVA-).

## Stack
React + Vite + TypeScript, Tailwind v4 (`@tailwindcss/vite`, CSS-first config, not v3), react-router, vite-plugin-pwa, Supabase JS client, Vitest. Hosting: Vercel (preview per branch, production from `main`). Android-first PWA; iOS is deferred, no iOS workarounds.

## Node
Node 20 (`20.x`), pinned in `.nvmrc` and `package.json` engines. Vite 8 needs 20.19 or newer within 20.x. Vercel project setting is also 20.x; keep the three in sync.

## Commands
- `npm install`
- `npm run dev` - local dev server (http://localhost:5173)
- `npm run build` - typecheck + production build (generates manifest and service worker)
- `npm test` - Vitest, single run (Tier 1; also runs in CI on every push)
- `node scripts/generate-icons.mjs` - regenerate placeholder PWA icons into `public/`

## Branch rules
- Work on `dev`. Never push to `main`; it requires a PR, and nothing goes to `main` without a "GO vX.X" comment from Dax on a release ticket.
- One open branch at a time. Every spec names its target branch.
- No ticket, no build. No spec, no build. Do not start a ticket Dax has not moved to Todo.
- Git identity is repo-local (GitHub no-reply). Do not change it. Never commit with a personal email address.

## Database rules
- **RLS on every table from day one.** No table ships without policies.
- Every migration is a local SQL file in `supabase/migrations/` before it is applied anywhere. No dashboard-only changes.

## Public repo rule
This repo is PUBLIC. No member data of any kind: no real names, emails, callsigns, seed data, fixtures, tests or screenshots. Obviously fake data only. A committed secret counts as leaked: rotate it, don't just delete it.

## Secrets and env
- `.env.local` holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; it is gitignored (`.env*.local`). Never print, log or commit it. `.env.example` has placeholders only.
- Anything prefixed `VITE_` ships to the browser. The service_role / secret key never goes in a `VITE_` variable, the repo, or this machine.
- Vercel env vars (Preview and Production scopes) are set by Dax in the dashboard. Without them the Supabase client is `null` and the app still renders.

## Linear conventions
Every comment opens with **@opr** (plain bold text, not a real mention). Cite tickets as plain identifiers (MVA-138). "Done" only when every acceptance criterion is met and Tier 1 is green. Tier 3 (Android device check) is Dax's.

## Tests
Tier 1: Vitest in CI on every push. Tier 2: Playwright smoke pre-release (not set up yet). Tier 3: Dax on a physical Android phone, installed PWA.

## Version tracking
- App version: 0.0.1
- Schema version: none (no tables)
- Last GO build: none
- Active branch: dev

## Claude Code setup
`.claude/commands/sos.md`, `.claude/commands/eos.md`, `.claude/agents/code-reviewer.md`, `.claude/settings.json` (shared). `settings.local.json` is gitignored. New command files need a Claude Code restart before `/sos` and `/eos` register.
