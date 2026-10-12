// Edge Function `send-push` (MVA-203 Phase A): delivers pending notifications as Web Push.
//
// Selection, windows and idempotency live in SQL (generate_reminders, events_notify, claim_pushes);
// this function only sends. It is called every minute by a pg_cron job (docs/DEPLOY.md) with the
// service-role key, and refuses anything else.
//
// Secrets (set with `supabase secrets set`, never in the repo or a VITE_ variable):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: or https: contact)
// Provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Payloads carry the title, a one-line body and an in-app link, nothing else. Endpoints and keys
// are never logged.

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

type Row = {
  notification_id: string
  title: string
  body: string
  link: string | null
  subscription_id: string
  endpoint: string
  p256dh: string
  auth: string
}

const url = Deno.env.get('SUPABASE_URL')
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY')
const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')
const vapidSubject = Deno.env.get('VAPID_SUBJECT')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405)
  if (!url || !serviceKey || !vapidPublic || !vapidPrivate || !vapidSubject) return json({ error: 'not configured' }, 500)

  // Only the service role (the cron job). The gateway already checked a valid JWT; an anon or
  // member token must not be able to trigger a send run.
  if (req.headers.get('authorization') !== `Bearer ${serviceKey}`) return json({ error: 'forbidden' }, 403)

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data, error } = await db.rpc('claim_pushes', { p_limit: 200 })
  if (error) return json({ error: 'claim failed' }, 500)
  const rows = (data ?? []) as Row[]

  let sent = 0
  let gone = 0
  let failed = 0

  // Small batches keep a burst from opening hundreds of connections at once.
  for (let i = 0; i < rows.length; i += 20) {
    await Promise.all(
      rows.slice(i, i + 20).map(async (r) => {
        const payload = JSON.stringify({ title: r.title, body: r.body, link: r.link ?? '/notifications' })
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, {
            TTL: 3600,
            urgency: 'normal',
          })
          sent++
          await db.rpc('push_succeeded', { p_subscription: r.subscription_id })
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            gone++
            await db.rpc('push_gone', { p_subscription: r.subscription_id })
          } else {
            failed++
            console.error('push failed', status ?? 'no status')
          }
        }
      }),
    )
  }

  return json({ claimed: rows.length, sent, gone, failed })
})
