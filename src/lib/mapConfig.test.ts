import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAP_ATTRIBUTION, MAP_DEFAULT_CENTER, MAP_LOAD_TIMEOUT_MS, MAP_STYLE_URL, mapFallbackMessage } from './mapConfig'

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

  it('has a plain fallback message that points at the coordinate fields when the map is editable (MVA-258)', () => {
    expect(mapFallbackMessage(true)).toMatch(/could not load/i)
    expect(mapFallbackMessage(true)).toMatch(/latitude and longitude/i)
    expect(mapFallbackMessage(false)).toMatch(/could not load/i)
    expect(mapFallbackMessage(false)).not.toMatch(/type the latitude/i)
  })
  it('gives up on a silent map after a sensible wait', () => {
    expect(MAP_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(MAP_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})

// MVA-258 regression guard. MapLibre 6 finds its worker next to the library chunk, which a Vite build
// does not ship; the worker must be named explicitly and PinMap must load that module first.
describe('map worker wiring', () => {
  const worker = readFileSync('src/lib/mapWorker.ts', 'utf8')
  it('names the worker file through a Vite ?url import and setWorkerUrl', () => {
    expect(worker).toMatch(/from 'maplibre-gl\/dist\/maplibre-gl-worker\.mjs\?url'/)
    expect(worker).toMatch(/setWorkerUrl\(workerUrl\)/)
  })
  it('is loaded by the map component', () => {
    expect(readFileSync('src/components/PinMap.tsx', 'utf8')).toMatch(/import '\.\.\/lib\/mapWorker'/)
  })
})
