/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { parsePayload } from './lib/pushPayload'

/**
 * The app's service worker (vite-plugin-pwa, injectManifest). It does what the generated worker
 * did before: precache the build (fonts and icons included) and fall back to the app shell for
 * navigation, so the app works offline at a field site. It also shows push notifications and
 * opens the right page when one is tapped (MVA-203).
 */
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> }

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

self.addEventListener('push', (event) => {
  const p = parsePayload(event.data?.text())
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      data: { link: p.link },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data as { link?: string } | undefined)?.link ?? '/hq'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const w of windows) {
        if ('focus' in w) {
          await w.focus()
          if ('navigate' in w) await (w as WindowClient).navigate(link)
          return
        }
      }
      await self.clients.openWindow(link)
    })(),
  )
})
