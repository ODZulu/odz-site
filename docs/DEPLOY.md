# Deploy

How the ODZ site gets from this repo to production. Anything marked **Dax** is done in a dashboard by Dax; credentials never go in the repo, in chat, or on a developer machine.

## Environments

| | Supabase project | Vercel scope |
| --- | --- | --- |
| Development and previews | the dev project | Preview and Development env vars |
| Production | ODZ-Prod, a separate prod project (MVA-140), served at https://odzulu.com | Production env vars |

Vercel env vars (set by **Dax** in the dashboard):

* `VITE_SUPABASE_URL` is the project API URL, `https://<project-ref>.supabase.co`. It is **not** the Vercel site URL.
* `VITE_SUPABASE_ANON_KEY` is the anon / publishable key.
* `VITE_VAPID_PUBLIC_KEY` is the public Web Push key (below).
* The service-role key never goes in a `VITE_` variable, in Vercel public vars, or in the repo. Anything with `VITE_` ships to the browser.

Vite bakes env vars in at build time: after changing one, redeploy.

## 1. Create the prod project (Dax)

1. New Supabase project, separate from dev. Save the database password in the password manager.
2. Decide the plan (MVA-140): **Pro** (about $25/month, daily backups, no pausing; recommended once members' private details are live) or free with a keep-alive. Private data means daily backups are required.

## 2. Apply the migrations (from the folder, in order, never ad hoc SQL)

The Supabase CLI is pinned as a devDependency (`supabase` 2.120.0, exact version in `package.json`); use `npx supabase ...` or the npm scripts, never `npx supabase@latest`. Log in once in your own terminal with `npx supabase login`.

```
npx supabase link --project-ref <prod-ref>
npm run db:list        # local vs remote history
npm run db:push:dry    # what would be applied
npm run db:push        # apply, in order
```

**All migrations are applied only with `db push` from this repo**, never through the dashboard SQL editor or an MCP/connector. Those record their own timestamps, so local and remote history diverge (this happened once on dev and was fixed with `supabase migration repair`). Prod starts clean this way. Dax runs the prod push in his own terminal after reviewing the dry run.

`supabase/migrations/` is the whole schema: tiers, capabilities, profiles, invites, private data, events, minutes, documents, HQ tables, notifications and the private `minutes` storage bucket. Later migrations are pushed one at a time, in order, after the initial push (MVA-207's phone/NKA and the event data model split are separate pushes). Tiers and capabilities are seeded by the migrations; **no test or sample data goes to prod**.

Run the SQL tests against a prod-shaped clone (a branch or the dev project), never prod: `supabase/tests/*.test.sql` (see docs/TESTING.md).

## 3. Auth settings (Dax, dashboard > Authentication)

* [x] **Confirm email: OFF** (no SMTP yet, MVA-200). The Email provider itself stays **on**.
* [x] **Minimum password length: 12.** In the dashboard this is under Sign In / Providers > Email (the label and location move between dashboard versions). The app checks 12 characters in the form, but the dashboard setting is the server-side control.
* [x] Rate limits left on.
* [x] Auth site URL and redirect `https://odzulu.com/**` set on ODZ-Prod (Dax, 2026-10-11).
* **Signup is invite-only, enforced in the database.** The signup trigger consumes an invite code and rejects everything else, so the public Auth endpoint cannot create an account without one. Verify after setup:

  ```
  curl -s -X POST "https://<prod-ref>.supabase.co/auth/v1/signup" \
    -H "apikey: <anon key>" -H "Content-Type: application/json" \
    -d '{"email":"nobody@example.invalid","password":"a-long-test-password-1"}'
  ```

  This must be refused: expect HTTP 500 with `{"code":"P0001","message":"Invite not valid"}` (older wording: "Database error saving new user"), and no user created. If it returns a user, stop and fix before release.

## 4. First admin

The first Admin is created by hand by **Dax**:

1. Run `supabase/seed/first_invite.sql` in the SQL editor; copy the code from the result.
2. Open `/join/<code>` on the site, create the account, finish account setup.
3. Run `supabase/seed/promote_admin.sql` with your email in a local edited copy (never committed).

Also usable: `supabase/seed/link_profile.sql` repairs a user that has an auth row but no profile.

## 5. Web Push (MVA-203)

Push stays **off** until this is done; the app shows "Push is not set up for this build yet" and in-app notifications keep working. Dev and prod each get their **own** key pair.

1. **Dax**, in a normal terminal outside Claude Code, in the repo: `npm run vapid:generate`. It prints a public and a private key to the terminal and writes nothing. Run it once for prod and once for dev. The private key never goes in chat, Linear, the repo or `.env.local`.
2. Public key to **Vercel** as `VITE_VAPID_PUBLIC_KEY`: **Production** scope for the prod pair, **Preview** and **Development** for the dev pair. Redeploy (Vite bakes it in at build time).
3. In the **matching Supabase project**, Dashboard > Edge Functions > Secrets, add these three (names exactly as `send-push` reads them):
   * `VAPID_PUBLIC_KEY`: the same public key
   * `VAPID_PRIVATE_KEY`: the private key
   * `VAPID_SUBJECT`: `mailto:<the detachment mailbox>`
4. Deploy the function: `npx supabase functions deploy send-push --project-ref <ref>`.
5. Run `supabase/seed/schedule_push.sql` once per environment (it needs the project URL and service-role key in Vault; instructions at the top of that file). `generate_reminders()` is scheduled by the migration itself every 5 minutes, when pg_cron is available. If the project pauses (free tier), reminders stop (MVA-140).

## 6. Advisors and audit

* Run the security advisor on prod after the migrations. Expect zero ERROR.
* The SECURITY DEFINER warnings are intentional: every such function pins `search_path = ''`, revokes execute from `public` and `anon`, and grants it only to the roles that need it (`authenticated`, or `service_role` for the push functions). `has_capability`, `current_user_is_admin` and `current_user_is_approved` must run as the owner so the policies that call them cannot recurse. The only function anon can call is `check_invite`, which answers true or false and rate-limits guesses.
* `check_invite` reads the caller's IP from `cf-connecting-ip`, then `x-real-ip`, then `x-forwarded-for`. After the first deploy, confirm one of those is set by checking `invite_attempts` keys after a few bad tries (keys look like `ip:<address>`; `ip:unknown` means none of the headers arrived and the lockout is global).

## 7. Backups and restore

**Pro:** daily backups are on by default (Dashboard > Database > Backups); point-in-time recovery is an add-on. To restore: pick the backup in the dashboard and restore, then check `select count(*) from public.profiles` and sign in as the Admin. Record the date of the last restore test here.

**Free plan (current state of ODZ-Prod, pending Dax's plan decision on MVA-140):** there are no automatic backups and the project pauses after about a week of inactivity. Until the plan is decided:

* Keep the pilot to 2-3 trusted members.
* **Manual backup, weekly and before any migration.** Run from a machine Dax controls, with the prod database password entered at the prompt (never stored in a file or the repo):

  ```
  npx supabase link --project-ref <prod-ref>
  npx supabase db dump -f ../odz-prod-schema.sql
  npx supabase db dump --data-only -f ../odz-prod-data.sql
  ```

  Write the dumps **outside the repo** (they contain member private data) into an encrypted location such as the password manager's file vault or an encrypted drive. Keep the last 4. Files in the `minutes` storage bucket are not in the dump; download them from Dashboard > Storage if needed.
* **Restore:** create a fresh project, `supabase db push` the migrations, then load the data dump with `psql`; re-point the Vercel Production env vars and redeploy.
* **Keep-alive:** a paused project also stops the pg_cron reminders. Any request to the project resets the inactivity clock, so open the site or sign in at least every few days (or restore the paused project from the dashboard). Upgrading to Pro removes this.

## 8. Pre-release audit (MVA-206)

* No secrets, no member data, no governance documents in the repo or the build. Check the built bundle:

  ```
  npm run build
  grep -rIil -e "allerg" -e "emergency" -e "date of birth" dist | head      # only UI labels may appear, never values
  grep -rIil -e "bylaws" dist | head                                           # the word may appear only as a document-type label, never document text
  grep -rI -e "service_role" -e "SERVICE_ROLE" dist | head                     # must be empty
  ```
* Version bumped and changelog updated.
* PR `dev` to `main` with the release checklist; **merge only after Dax's GO comment on the release ticket.** Rollback is Vercel's instant rollback to the previous deployment.
