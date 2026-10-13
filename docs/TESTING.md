# Testing

Three tiers (ODZ - Development SOP). A ticket is Done only when Tier 1 and Tier 2 are green and Dax passes Tier 3.

| Tier | What | Where |
| ---- | ---- | ----- |
| 1 | Vitest unit tests, plus plain-SQL database tests | CI on every push |
| 2 | Playwright end-to-end (Pixel-class mobile + desktop Chromium) | CI on pull requests to `dev`; locally with Docker |
| 3 | Dax on a physical Android phone, installed PWA | By hand |

The repo is public. Every value in a test is obviously fake (`e2e-` emails on `example.invalid`, callsigns `E2E-...`, DOB 2000-01-01, phone numbers in the 555-01xx range). The helpers refuse to run against anything but a local stack.

## Tier 1

```
npm test
```

Database tests are plain SQL that run in one rolled-back transaction: `supabase/tests/*.test.sql`. Run them against the local stack (below), a branch database, or the dev project, never one holding real members. A failure raises an exception; success ends with a `ALL PASS` notice.

## Tier 2

### Path A (preferred): local Supabase stack

Needs Docker and the Supabase CLI.

```
supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor
eval "$(supabase status -o env)"          # bash; sets API_URL, ANON_KEY, SERVICE_ROLE_KEY
export E2E_SUPABASE_URL=$API_URL E2E_SUPABASE_ANON_KEY=$ANON_KEY E2E_SUPABASE_SERVICE_KEY=$SERVICE_ROLE_KEY
npm run test:e2e
```

`supabase start` builds the database from `supabase/migrations` in order, with the auth settings in `supabase/config.toml` (email confirmation off, minimum password 12). The keys it prints belong to the throwaway local stack. The service-role key is used only by the test helpers (`e2e/helpers/backend.ts`), which refuse any URL that is not `127.0.0.1` or `localhost`. The dev server is started with only the URL and the anon key, so the service-role key never reaches the client bundle.

CI does exactly this on pull requests to `dev` and on manual trigger (`.github/workflows/ci.yml`), with the keys masked.

Cleanup: every run removes the `e2e-` users (profiles and private rows cascade), their audit rows and the invites it made, then clears the failed-guess counters. Running the suite twice in a row is the proof.

### Path B (no Docker): UI-only suites

Without the `E2E_*` variables the backend suites skip themselves and the UI-only suite (`e2e/public.spec.ts`) runs against the dev server with no Supabase configured:

```
E2E_CHANNEL=chrome npm run test:e2e:ui     # uses the installed Chrome instead of downloading Chromium
```

There is no service-role fallback against the hosted dev project: the service-role key never goes on a developer machine (CLAUDE.md), so full flows need Path A or CI.

### Suites

* `e2e/public.spec.ts` (no backend): anonymous visitors are sent to login from every app route; no public page links to `/join` or says how people join; login has no forgot-password link; the PWA manifest is served; no horizontal scroll at phone width.
* `e2e/invite-flow.spec.ts` (backend): valid invite to signup to setup to pending; unknown, used, expired and revoked codes show the identical error; pending and setup-incomplete accounts are redirected from app routes; approved members reach HQ; a wrong password gives the generic message.
* `e2e/api.spec.ts` (backend): anon cannot read `invites`, `member_private` and friends; `check_invite` is boolean only; a member reads only their own private row and cannot escalate; only approvers create invites and the code is server-generated.

* `e2e/admin.spec.ts` (backend): a member cannot reach `/admin`; Command sees invites, pending, members and audit but not tiers; Admin sees every section; an invite code is shown in full once and afterwards only its last four characters; approve_members cannot be stripped from its only tier; changing private-details access needs the typed word.

* `e2e/calendar.spec.ts` (backend): anonymous visitors get titles and times and no location, directions or description in any network response (and never touch the `events` table); a Recruit sees the listing but not the details; a Member sees location, directions and description; a script in a description renders inert; Command creates (with validation), edits and cancels an event.

* `e2e/directory.spec.ts` (backend): the roster lists approved members, is searchable and hides pending accounts; a member edits their own profile and a script in the bio stays inert; private details show only to the owner and Command; a member cannot rename themselves or change their tier through the API.

* `e2e/archive.spec.ts` (backend, needs the storage service): a Recruit gets nothing from minutes or documents; Command writes minutes with a file, a disguised executable is refused, a draft stays hidden until published, a script in the notes renders inert; stored files are unreachable without a signed link; document drafts stay hidden and ratifying a new version supersedes the old one.

* `e2e/hq.spec.ts` (backend): every HQ panel has an empty state and anon reads no traffic; Command posts traffic, a Member sees it pinned first as plain text and cannot post, archived posts disappear for members; RSVP answers update the readiness counts and a past event is closed.

* `e2e/removal.spec.ts` (backend): Admin removes a member from the roster page (reason required, separate confirm), private details are purged and the profile is marked removed; a removed member cannot sign in and an earlier session reads nothing; Command is not offered removal and the RPC refuses it, as it does anon and members; an Admin cannot remove themselves; authored traffic shows "Former member" after removal and after the permanent delete.

New tickets add their suites to `e2e/` and list them here.

## Failure artifacts

Screenshots, traces and the HTML report are written to `test-results/` and `playwright-report/` (gitignored) and uploaded as CI artifacts for 7 days. They contain fake data only.
