# Email (MVA-200)

Real email comes from `noreply@odzulu.com` (sender name `ODZ`) through Resend, wired into Supabase Auth as custom SMTP. The app uses it for **forgot password** (`/forgot-password` then `/reset-password`) and, if Dax turns it on, **email confirmation** at signup. Dev and prod use separate credentials. Credentials live only in the Supabase dashboard and the provider: never in the repo, `.env*`, logs or Linear.

If SMTP is misconfigured or down the site keeps working: sign-in is unaffected, and the forgot page still shows its neutral message (it cannot tell the visitor whether a send worked). Fallback is the Admin-set password path ("Locked out? Contact Command").

## How the app behaves

* Login has a **Forgot password?** link. `/forgot-password` calls `resetPasswordForEmail` with the redirect `<origin>/reset-password` and **always** shows "If that address has an account, a reset link is on its way." Known, unknown, pending, suspended and removed addresses are indistinguishable.
* `/reset-password` works only in a tab that arrived through a recovery link (Supabase's `PASSWORD_RECOVERY` event, remembered per tab). Anyone else, an expired link, or a used link gets one generic message and a link back to `/forgot-password`. A normal signed-in session cannot use the page to skip the current password (that is the Me page, MVA-248).
* The new password uses the same 12-character rule as signup, with a confirm field. On success the app **signs out** and shows the login screen with a confirmation line. The existing gates are untouched: a suspended, removed or pending account that resets its password still lands on the denied or pending screen at sign-in.
* Nothing logs an email address, token or password.

## Email confirmation: current decision

Confirm email stays **OFF** (`[auth.email] enable_confirmations = false`, and off in the dashboards unless Dax changes it). The code works either way: with confirmation ON, `signUp` returns no session, the join page shows "Open the confirmation link we emailed you, then sign in", the link returns to `/login`, and a sign-in before confirming shows "Confirm your email first". The invite is consumed and the pending profile created at signup, so after confirming the member signs in and lands on setup, then pending. Turning it on is a dashboard switch (Dax); retest the invite flow on dev before doing it on prod. See the ticket for the findings.

## Part A: Supabase project setup (Dax, dashboard; repeat per project)

1. Provider account (Resend), domain `odzulu.com` verified: SPF, DKIM, optional DMARC `p=none` at the DNS host. Wait for "Verified".
2. Supabase, Auth, SMTP Settings: enable custom SMTP (`smtp.resend.com`, port 465, the provider's user and a **project-specific** API key as password), sender `ODZ <noreply@odzulu.com>`.
3. Supabase, Auth, URL Configuration:
   * **Site URL**: the stable address of that environment (dev: the stable dev branch alias, not a per-deployment URL; prod: `https://odzulu.com`).
   * **Redirect URLs** must allow the reset page, which is a path, so use a wildcard: `<site>/**` (dev also `http://localhost:5173/**`). An entry without `/**` does **not** match `/reset-password`, and the link then lands on the Site URL instead.
4. Auth, Email Templates (Reset Password, Confirm signup): plain wording, no emoji, no exclamation marks, no member data.
5. Auth, Rate Limits: sensible for about 20 users.

## Part C: prod rollout (gated)

Only after Dax's Tier 3 pass on dev. Dax repeats Part A on the **prod** project with its own credential, Site URL `https://odzulu.com` and a prod-only redirect list. Code reaches `main` only with the normal release GO. No migration is involved.

## Testing

* Tier 1 (Vitest): `src/lib/recovery.test.ts` (validators, neutral message, recovery marker).
* Tier 2 (Playwright): `e2e/password-reset.spec.ts` covers the login link, the neutral message, the no-link error, the signed-in-session guard and, when the local mail catcher (Mailpit, `http://127.0.0.1:54324`) is up, the whole flow: request, read the link from Mailpit, set a password, old password rejected, a suspended account still denied, link single-use. No real email is sent from CI. Local runs: `supabase start`, then `npm run test:e2e`. The local stack allows only a couple of auth emails per hour, so rerun the flow test sparingly.
* Tier 3 (Dax, dev preview, real inbox): reset email to a non-team Gmail address arrives in the inbox, the link opens `/reset-password`, the new password works and the old does not, a reused link shows the generic error, an unknown address shows the same neutral message and no mail arrives.

## Rotating the SMTP credential

1. In the provider, create a new API key for that environment.
2. Supabase, Auth, SMTP Settings: replace the password with the new key and save.
3. Send a test (Auth, Users, "Send password recovery" on a throwaway account, or use the forgot page) and confirm it arrives.
4. Delete the old key in the provider. Do this per environment; dev and prod keys are never shared.
