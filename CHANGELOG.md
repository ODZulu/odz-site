# Changelog

## 0.1.0 (release candidate, MVA-206)

First production release. Invite-only; nobody holds a code until the first Admin is created after the deploy.

### Added
- Installable Android-first PWA with a public calendar.
- Invite-only signup, enforced in the database. Failed guesses are rate-limited and locked out.
- First-login account setup with private member data. Phones are stored as `xxx-xxx-xxxx` and "no known allergies" as `NKA` (MVA-207).
- Tier ladder and per-tier capabilities, an approval flow, a roster, and an audit log.
- Admin settings for tiers, capabilities and invites.
- Events and a calendar. Anonymous visitors see title, type, time and status only. Location, directions and description sit in a separate table readable with `read_event_details`; `public_events` is gone (MVA-140).
- RSVPs, HQ panels, minutes and documents (private storage bucket).
- In-app notifications and Web Push. Push does not deliver in this release: the `send-push` function and its schedule are deployed after the first Admin exists.

### Fixed
- RSVP save is update-then-insert. Members hold UPDATE on `response` only, so the old upsert was refused.

### Database
- 12 migrations, applied to ODZ-Prod with `supabase db push`. See `supabase/migrations/README.md`.

### Release notes
- The first Admin is created right after the deploy: new invite, join, `promote_admin`, revoke leftover codes (MVA-206 ruling).
