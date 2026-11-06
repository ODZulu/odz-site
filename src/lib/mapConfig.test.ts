import { describe, expect, it } from 'vitest'
import { MAP_ATTRIBUTION, MAP_DEFAULT_CENTER, MAP_STYLE_URL } from './mapConfig'

describe('mapConfig', () => {
  it('uses OpenFreeMap over https with no key or token in the URL', () => {
    const u = new URL(MAP_STYLE_URL)
    expect(u.protocol).toBe('https:')
    expect(u.hostname).toBe('tiles.openfreemap.org')
    expect(u.search).toBe('')
    expect(MAP_STYLE_URL).not.toMatch(/key|token|apikey|access/i)
  })
  it('never points at the retired USGS imagery service', () => {
    expect(MAP_STYLE_URL).not.toMatch(/usgs|nationalmap/i)
  })
  it('credits OpenMapTiles and OpenStreetMap', () => {
    expect(MAP_ATTRIBUTION).toContain('OpenMapTiles')
    expect(MAP_ATTRIBUTION).toContain('OpenStreetMap')
  })
  it('starts centred on valid coordinates', () => {
    expect(Math.abs(MAP_DEFAULT_CENTER.lat)).toBeLessThanOrEqual(90)
    expect(Math.abs(MAP_DEFAULT_CENTER.lng)).toBeLessThanOrEqual(180)
  })
})
