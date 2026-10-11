import { describe, expect, it } from 'vitest'
import { LEAD_PRESETS, normalizeLeads, parsePayload, pushSupport, safeLink, urlBase64ToUint8Array } from './pushPayload'

describe('safeLink', () => {
  it('keeps same-origin paths', () => {
    expect(safeLink('/calendar')).toBe('/calendar')
    expect(safeLink('/roster/Fox-Trot')).toBe('/roster/Fox-Trot')
  })
  it.each(['https://evil.example.invalid', '//evil.example.invalid', 'javascript:alert(1)', '/a b', '/a?x=1', '', null, 42])(
    'replaces %s with /hq',
    (v) => expect(safeLink(v)).toBe('/hq'),
  )
})

describe('parsePayload', () => {
  it('reads a good payload', () => {
    expect(parsePayload('{"title":"Fake Op","body":"Starts 10 OCT 2026 0630L","link":"/calendar"}')).toEqual({
      title: 'Fake Op',
      body: 'Starts 10 OCT 2026 0630L',
      link: '/calendar',
    })
  })
  it('falls back safely for junk, empty and non-JSON', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"str"']) {
      const p = parsePayload(raw as string)
      expect(p.title.length).toBeGreaterThan(0)
      expect(p.link.startsWith('/')).toBe(true)
    }
  })
  it('never lets a hostile link through and clamps long text', () => {
    const p = parsePayload(JSON.stringify({ title: 't'.repeat(500), body: 'b'.repeat(500), link: 'https://evil.example.invalid' }))
    expect(p.link).toBe('/hq')
    expect(p.title.length).toBe(120)
    expect(p.body.length).toBe(200)
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 with and without padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255])
  })
  it('decodes a 65-byte VAPID-shaped key', () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(65).fill(4))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(urlBase64ToUint8Array(key)).toHaveLength(65)
  })
})

describe('lead times', () => {
  it('offers exactly the four presets', () => expect(LEAD_PRESETS.map((p) => p.minutes)).toEqual([1440, 720, 120, 30]))
  it('normalises: unique, longest first', () => expect(normalizeLeads([30, 1440, 30, 120])).toEqual([1440, 120, 30]))
  it('rejects empty and non-preset values', () => {
    expect(normalizeLeads([])).toBeNull()
    expect(normalizeLeads([45])).toBeNull()
    expect(normalizeLeads([1440, 0])).toBeNull()
  })
})

describe('pushSupport', () => {
  const base = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIos: false, standalone: false }
  it('supports a capable browser', () => expect(pushSupport(base)).toEqual({ supported: true }))
  it('explains iOS Safari outside the installed app', () => {
    const r = pushSupport({ ...base, isIos: true })
    expect(r.supported).toBe(false)
    if (!r.supported) expect(r.reason).toMatch(/iOS/)
  })
  it('explains a browser without push', () => {
    expect(pushSupport({ ...base, hasPushManager: false }).supported).toBe(false)
    expect(pushSupport({ ...base, hasServiceWorker: false }).supported).toBe(false)
  })
})
