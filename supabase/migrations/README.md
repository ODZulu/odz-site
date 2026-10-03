# Migrations

Rules (ODZ - Development SOP 5.2, Playbook section 4):

1. Every migration is a local SQL file in this folder **before** it is applied anywhere.
2. RLS is enabled on every table, with policies, from the migration that creates it. No table ships without policies.
3. No dashboard-only changes. If it is not in a file here, it does not exist.

Name files `YYYYMMDDHHMMSS_short_description.sql`. This folder is empty until the first data-model ticket.

The repo is public: no member data in migrations, seeds or fixtures. Obviously fake data only.
