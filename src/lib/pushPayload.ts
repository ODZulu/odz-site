/**
 * Pure helpers shared by the service worker and the app (MVA-203). No imports, so the service
 * worker bundle stays small and these are easy to test.
 */

export type PushPayload = { title: string; body: string; link: string }

/** Only same-origin paths. Anything else (other origins, protocol-relative, javascript:) becomes /hq. */
export function safeLink(link: unknown): string {
  return typeof link === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(link) && !link.startsWith('//') ? link : '/hq'
}

/** Turns whatever arrived in a push event into something safe to show. Never throws. */
export function parsePayload(raw: string | null | undefined): PushPayload {
  const fallback: PushPayload = { title: 'ODZ', body: 'You have a new notification.', link: '/notifications' }
  if (!raw) return fallback
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 120) : fallback.title
    const body = typeof data.body === 'string' ? data.body.trim().slice(0, 200) : ''
    return { title, body, link: safeLink(data.link ?? '/notifications') }
  } catch {
    return fallback
  }
}

/** Decodes a VAPID public key (URL-safe base64) for pushManager.subscribe. */
export function urlBase64ToUint8Array(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export const LEAD_PRESETS = [
  { minutes: 1440, label: '24 hours before' },
  { minutes: 720, label: '12 hours before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 30, label: '30 minutes before' },
] as const

const PRESET_MINUTES: number[] = LEAD_PRESETS.map((p) => p.minutes)

/** At least one preset, only presets, no duplicates, longest lead first. Null means invalid. */
export function normalizeLeads(selected: number[]): number[] | null {
  const unique = [...new Set(selected)]
  if (unique.length === 0 || unique.some((m) => !PRESET_MINUTES.includes(m))) return null
  return unique.sort((a, b) => b - a)
}

export type PushSupport = { supported: true } | { supported: false; reason: string }

/** Whether this browser can do web push. iOS Safari outside the installed app cannot (iOS is deferred). */
export function pushSupport(env: { hasServiceWorker: boolean; hasPushManager: boolean; hasNotification: boolean; isIos: boolean; standalone: boolean }): PushSupport {
  if (env.isIos && !env.standalone) {
    return { supported: false, reason: 'Push notifications are not available in iOS Safari. In-app notifications still work.' }
  }
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return { supported: false, reason: 'This browser does not support push notifications. In-app notifications still work.' }
  }
  return { supported: true }
}
