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

## Bootstrap the first admin (manual, once)

1. Sign up in the app so the account and its pending profile exist.
2. Copy `supabase/seed/promote_admin.sql` into the Supabase SQL editor, replace the placeholder email there, and run it. Never commit the edited copy.

## Tests

`supabase/tests/db_foundation.test.sql` is plain SQL that runs in one transaction and rolls back. Run it against a dev or branch database only, never one holding real members. It raises an exception on the first failed check.

## Applied state

Both migrations are applied to the ODZ dev project (2026-10-10) and the test file passes there. Filenames carry the versions Supabase recorded. The security advisor warns that `has_capability`, `current_user_is_admin` and `current_user_is_approved` are executable by signed-in users. That is intended: the RLS policies call them as the invoking role, and each only answers a question about the caller.
