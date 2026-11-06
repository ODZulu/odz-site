/**
 * Coordinates for events (MVA-224). Pure helpers, no map provider: a provider is Dax's decision
 * (see the PR), and everything here works without one.
 */

export type CoordResult =
  | { ok: true; value: { lat: number; lng: number } | null }
  | { ok: false; error: string }

const NUM = /^-?\d{1,3}(\.\d{1,6})?$/

/** Both empty means no pin. Otherwise both must be decimal degrees in range (6 decimals is about 10 cm). */
export function parseCoordinates(latText: string, lngText: string): CoordResult {
  const lat = latText.trim()
  const lng = lngText.trim()
  if (lat === '' && lng === '') return { ok: true, value: null }
  if (lat === '' || lng === '') return { ok: false, error: 'Enter both latitude and longitude, or clear both.' }
  if (!NUM.test(lat) || !NUM.test(lng)) return { ok: false, error: 'Use decimal degrees, like 33.4484 and -112.0740.' }
  const a = Number(lat)
  const b = Number(lng)
  if (a < -90 || a > 90) return { ok: false, error: 'Latitude must be between -90 and 90.' }
  if (b < -180 || b > 180) return { ok: false, error: 'Longitude must be between -180 and 180.' }
  return { ok: true, value: { lat: a, lng: b } }
}

/** Rounds a browser geolocation reading to what the database stores. */
export const roundCoord = (n: number): string => String(Math.round(n * 1e6) / 1e6)

/** Opens the phone's default maps app on Android; a plain link, no provider integration. */
export const geoLink = (lat: number, lng: number): string => `geo:${lat},${lng}?q=${lat},${lng}`

/** A plain link out to OpenStreetMap for desktops. Nothing is embedded or fetched from it. */
export const osmLink = (lat: number, lng: number): string => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`
