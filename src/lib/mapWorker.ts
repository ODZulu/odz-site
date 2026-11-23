import { setWorkerUrl } from 'maplibre-gl'
// `?url` makes Vite emit the worker as its own file and hand back its real address.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'

/**
 * MVA-258: MapLibre GL 6 starts its tile worker from `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)`, a file next to whichever chunk holds the library. Vite never sees that inside a
 * dependency, so the file was not shipped: the request fell through to Vercel's `/(.*)` rewrite and
 * got index.html back, the worker died, and the map drew only its background colour and the pin.
 * Naming the worker file here is MapLibre's supported override. Import this before making a map.
 */
setWorkerUrl(workerUrl)
