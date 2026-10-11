# Migrations

Rules (ODZ - Development SOP 5.2, Playbook section 4):

1. Every migration is a local SQL file in this folder **before** it is applied anywhere.
2. RLS is enabled on every table, with policies, from the migration that creates it. No table ships without policies.
3. No dashboard-only changes. If it is not in a file here, it does not exist.

Name files `YYYYMMDDHHMMSS_short_description.sql`.

The repo is public: no member data in migrations, seeds or fixtures. Obviously fake data only.

## Applying

Apply files in filename order to the ODZ Supabase project (SQL editor or `supabase db push`). If you apply through the dashboard or an MCP tool that stamps its own timestamp, rename the local file to match the recorded version so history stays in sync.

## Current schema (MVA-198)

`20261010181521_db_foundation.sql`: `tiers`, `capabilities`, `tier_capabilities`, `profiles`, the signup trigger, `has_capability()`, RLS on all four tables, and the first seed.

`20261010181757_tier_model_and_audit.sql`: Dax decisions of 2026-10-09 and 10-10. Ladder is Command > Old Guard > Member > Contractor > Prospect > Recruit (Admin is the `is_admin` flag, not a tier); lower `rank` means more authority. Command requires Old Guard to enter and releases back to Old Guard, stored as data on the tier (`entry_requires_tier_id`, `release_to_tier_id`). New `edit_roster` capability (Command by default) governs tier changes; `approve_members` governs status, and may assign the tier when approving a pending account. `profile_audit` records who changed status, tier or admin and when (append-only, written by trigger, readable by approvers and roster editors). Recruit is the default tier on approval.

`20261011121739_invites_and_private_data.sql` (MVA-199, applied 2026-10-11): invite-only signup, first-login setup, private member data.
* `invites` (server-generated 20-char code, tier Recruit/Prospect/Contractor, 7-day expiry, single use, revocable) with `invite_audit`. Command/Admin (`approve_members`) issue, read and revoke; nobody else can read them.
* Signup is gated in the database: `handle_new_user()` consumes the code from the signup metadata (`invite_code`) via `redeem_invite()`, so a direct Auth API call without a valid code fails. Side effect: users cannot be created from the dashboard without an invite either (make one with `supabase/seed/first_invite.sql`).
* `check_invite(code)` is the only anon-callable function. It returns true/false, never says why, and locks a source out for 15 minutes after 5 bad guesses (50 overall). It identifies the source from `cf-connecting-ip`, then `x-real-ip`, then the first `x-forwarded-for` entry; verify on the live project that one of these is set by Supabase's proxy.
* `member_private` (legal name, date of birth, phone, allergies, emergency contact): owner reads/writes own row; `view_member_private` (Command) reads all; only admins delete. Writes are logged in `profile_audit` (event `private`) by field name only. `complete_setup()` validates and writes it atomically and sets `profiles.setup_complete`; its errors are fixed codes that never echo values.
* `20261011130000_remove_bootstrap_admin.sql`: signup is invite-only for every address. The initial admin was created by hand in the Supabase dashboard (a dashboard-added user needs an invite code in its metadata too; see that file).
* `approve_member()` / `reject_member()` (need `approve_members`; approval requires completed setup and keeps the invited tier).

`20261011140000_admin_settings.sql` (MVA-141): invite codes become show-once (`create_invite()` returns the code; only `code_hint`, the last 4 characters, is readable afterwards; direct inserts closed). `list_invites()`, `list_audit()` (profile, invite and settings events, field names only for private data), `my_capabilities()`. Tiers and capabilities change only through admin RPCs (`create_tier`, `rename_tier`, `reorder_tiers`, `delete_tier`, `set_tier_capability`); direct writes revoked. Guards: Command entry/release rules cannot be changed, a tier with members cannot be deleted, `approve_members` cannot be removed from every tier, `view_member_private` changes need the typed word `PRIVATE`, nobody changes their own tier. `tiers.invitable` replaces the name check for which tiers an invite may grant. New `settings_audit` table.

`20261011150000_events.sql` (MVA-201): `events` (RLS: read needs `read_event_details`, write needs `write_events`; no client can set `created_by` or `external_id`), the `public_events` view (title, type, times, status only; the only thing anon can read), audit rows in `settings_audit` (titles only). `read_event_details` is removed from Recruit, Prospect and Contractor (Member and above keep it; Admin can toggle it).

`20261011160000_profiles_directory.sql` (MVA-204): `profiles.role_note` (<=60), `bio` (<=280), `joined_at` (first approval; backfilled). Members edit only display name, role note and bio through `update_own_profile()`; direct updates of profiles are closed except tier, status and is_admin for roster managers (the own-row update policy is gone). `set_callsign()` (edit_roster) and `update_own_private()` added; profile edits are audited by field name only.

## Dashboard settings this schema assumes (Auth)

* Email confirmation OFF (no SMTP yet, MVA-200).
* Minimum password length 12 (the client enforces it too, but the dashboard setting is the server-side control).

## Other admins (manual)

The first admin is automatic (above). To promote someone else:

1. Create an invite with `supabase/seed/first_invite.sql` (SQL editor; the code appears in the result), then sign up at `/join` with it and finish account setup, so the account and its pending profile exist.
2. Copy `supabase/seed/promote_admin.sql` into the Supabase SQL editor, replace the placeholder email there, and run it. Never commit the edited copy.

## Tests

`supabase/tests/db_foundation.test.sql` and `supabase/tests/invites_private.test.sql` are plain SQL that runs in one transaction and rolls back. Run it against a dev or branch database only, never one holding real members. It raises an exception on the first failed check.

## Applied state

All three migrations are applied to the ODZ dev project (2026-10-10 and 2026-10-11) and both test files pass there. Filenames carry the versions Supabase recorded. The security advisor warns that `has_capability`, `current_user_is_admin` and `current_user_is_approved` are executable by signed-in users. That is intended: the RLS policies call them as the invoking role, and each only answers a question about the caller.
