import { describe, expect, it } from 'vitest'
import { geoLink, osmLink, parseCoordinates, roundCoord } from './geo'

describe('parseCoordinates', () => {
  it('treats both empty as no pin', () => expect(parseCoordinates('', ' ')).toEqual({ ok: true, value: null }))
  it('parses decimal degrees', () => expect(parseCoordinates('33.4484', '-112.0740')).toEqual({ ok: true, value: { lat: 33.4484, lng: -112.074 } }))
  it('accepts the extremes', () => {
    expect(parseCoordinates('90', '180').ok).toBe(true)
    expect(parseCoordinates('-90', '-180').ok).toBe(true)
  })
  it('needs both or neither', () => {
    expect(parseCoordinates('33.4', '').ok).toBe(false)
    expect(parseCoordinates('', '-112').ok).toBe(false)
  })
  it('rejects out of range and junk', () => {
    for (const [a, b] of [['90.1', '0'], ['0', '180.5'], ['-91', '0'], ['abc', '1'], ['1,5', '2'], ['1.1234567', '2'], ['', 'x']]) {
      expect(parseCoordinates(a, b).ok).toBe(false)
    }
  })
})

describe('links and rounding', () => {
  it('rounds to six decimals', () => expect(roundCoord(33.44839999999)).toBe('33.4484'))
  it('builds plain links with no provider key', () => {
    expect(geoLink(33.4, -112.1)).toBe('geo:33.4,-112.1?q=33.4,-112.1')
    expect(osmLink(33.4, -112.1)).toContain('openstreetmap.org')
  })
})
