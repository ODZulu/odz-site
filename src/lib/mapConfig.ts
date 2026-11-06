/**
 * The one place the map source is named (MVA-224, provider approved by Dax 2026-11-06):
 * MapLibre GL JS drawing OpenFreeMap vector tiles. OpenFreeMap needs no API key and no account, so
 * there is no key anywhere in this repo. To change the source later, change it here and nowhere
 * else. (Future tactical layers would be extra sources on the same map component; not built.)
 *
 * Do not point this at the USGS Imagery Topo service (retired after 2026-11-16).
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

/** Shown on every map. OpenFreeMap's terms ask for credit to OpenMapTiles and OpenStreetMap. */
export const MAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'

/** Where an empty map is centred (Phoenix) and how far in it starts. */
export const MAP_DEFAULT_CENTER = { lat: 33.4484, lng: -112.074 } as const
export const MAP_DEFAULT_ZOOM = 9
/** Zoom when there is a pin to show. */
export const MAP_PIN_ZOOM = 14
