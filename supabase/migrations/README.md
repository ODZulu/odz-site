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

`20261009160000_db_foundation.sql`: `tiers`, `capabilities`, `tier_capabilities`, `profiles`, the signup trigger, `has_capability()`, RLS on all four tables, and the seed ladder (Command, Old Guard, Member, Prospect, Recruit). Lower `rank` means more authority. `Member` is seeded as the default tier on approval (`is_default_for_approval`); change it in the tiers table if that is wrong.

## Bootstrap the first admin (manual, once)

1. Sign up in the app so the account and its pending profile exist.
2. Copy `supabase/seed/promote_admin.sql` into the Supabase SQL editor, replace the placeholder email there, and run it. Never commit the edited copy.

## Tests

`supabase/tests/db_foundation.test.sql` is plain SQL that runs in one transaction and rolls back. Run it against a dev or branch database only, never one holding real members. It raises an exception on the first failed check.
