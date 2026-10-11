import { LEAD_PRESETS, normalizeLeads, pushSupport, urlBase64ToUint8Array, type PushSupport } from './pushPayload'
import { supabase } from './supabase'

/** Notification data access and the browser push flow (MVA-203). */

export type NotificationRow = {
  id: string
  kind: 'reminder' | 'new' | 'cancelled' | 'changed' | 'test'
  title: string
  body: string
  link: string | null
  created_at: string
  read_at: string | null
}

export type Prefs = { push_enabled: boolean; lead_minutes: number[] }
export const DEFAULT_PREFS: Prefs = { push_enabled: false, lead_minutes: [1440, 120] }

export const KIND_LABEL: Record<NotificationRow['kind'], string> = {
  reminder: 'REMINDER',
  new: 'NEW EVENT',
  cancelled: 'CANCELLED',
  changed: 'CHANGED',
  test: 'TEST',
}

export function currentSupport(): PushSupport {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return pushSupport({
    hasServiceWorker: !!nav && 'serviceWorker' in nav,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof window !== 'undefined' && 'Notification' in window,
    isIos: !!nav && /iPad|iPhone|iPod/.test(nav.userAgent),
    standalone: typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches === true,
  })
}

export const vapidPublicKey = (): string | undefined => import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

export async function loadPrefs(): Promise<Prefs> {
  const { data, error } = await supabase!.from('notification_prefs').select('push_enabled,lead_minutes').maybeSingle()
  if (error) throw new Error('prefs')
  return (data as Prefs | null) ?? DEFAULT_PREFS
}

export async function savePrefs(p: Prefs): Promise<void> {
  const leads = normalizeLeads(p.lead_minutes)
  if (!leads) throw new Error('prefs')
  const { error } = await supabase!
    .from('notification_prefs')
    .upsert({ push_enabled: p.push_enabled, lead_minutes: leads }, { onConflict: 'profile_id' })
  if (error) throw new Error('prefs')
}

export type EnableResult = { ok: true } | { ok: false; reason: string }

/** Permission, subscribe, register with the server, then switch push on. */
export async function enablePush(): Promise<EnableResult> {
  const support = currentSupport()
  if (!support.supported) return { ok: false, reason: support.reason }
  const key = vapidPublicKey()
  if (!key) return { ok: false, reason: 'Push is not set up for this build yet.' }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: 'Notifications are blocked. Allow them in the browser settings, then try again.' }
  try {
    const reg = await navigator.serviceWorker.ready
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }))
    const json = sub.toJSON()
    const { error } = await supabase!.rpc('register_push_subscription', {
      p_endpoint: sub.endpoint,
      p_p256dh: json.keys?.p256dh,
      p_auth: json.keys?.auth,
      p_user_agent: navigator.userAgent.slice(0, 300),
    })
    if (error) return { ok: false, reason: 'Could not register this device. Try again.' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'Could not turn on push on this device.' }
  }
}

/** Unsubscribes this browser and removes it from the server. */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe()
      await supabase!.rpc('unregister_push_subscription', { p_endpoint: endpoint })
    }
  } catch {
    // Nothing to undo on a browser without push.
  }
}

export async function sendTest(): Promise<'ok' | 'too_soon' | 'failed'> {
  const { error } = await supabase!.rpc('send_test_notification')
  if (!error) return 'ok'
  return error.message === 'too_soon' ? 'too_soon' : 'failed'
}

export async function loadNotifications(limit = 50): Promise<NotificationRow[]> {
  const { data, error } = await supabase!
    .from('notifications')
    .select('id,kind,title,body,link,created_at,read_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error('notifications')
  return data as NotificationRow[]
}

export async function unreadCount(): Promise<number> {
  const { count, error } = await supabase!.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
  if (error) throw new Error('notifications')
  return count ?? 0
}

export async function markRead(id: string): Promise<void> {
  await supabase!.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null)
}

export async function markAllRead(): Promise<void> {
  await supabase!.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)
}

export { LEAD_PRESETS }
