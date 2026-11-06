import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MAP_ATTRIBUTION, MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, MAP_PIN_ZOOM, MAP_STYLE_URL } from '../lib/mapConfig'

export type Pin = { lat: number; lng: number }

/**
 * The map (MVA-224). Editable: tap or click to drop the pin, drag it to adjust. Read-only: a small
 * static preview that does not pan or zoom. The pin is always the `value`; the parent owns it and
 * is told through `onPick`, so typing coordinates and tapping the map stay in step. Loaded lazily
 * (see PinFields and EventMapToggle) so the map code never weighs on the rest of the app.
 */
export default function PinMap({
  value,
  editable,
  onPick,
  height = 260,
}: {
  value: Pin | null
  editable: boolean
  onPick?: (lat: number, lng: number) => void
  height?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const marker = useRef<Marker | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick
  const first = useRef(value)
  const [failed, setFailed] = useState(false)

  // The map itself, created once per mode.
  useEffect(() => {
    if (!box.current) return
    let m: MapLibreMap
    try {
      const start = first.current ?? MAP_DEFAULT_CENTER
      m = new MapLibreMap({
        container: box.current,
        style: MAP_STYLE_URL,
        center: [start.lng, start.lat],
        zoom: first.current ? MAP_PIN_ZOOM : MAP_DEFAULT_ZOOM,
        interactive: editable,
        // Two fingers move the map, so a one-finger scroll past the form is not caught by it.
        cooperativeGestures: editable,
        attributionControl: { compact: true, customAttribution: MAP_ATTRIBUTION },
      })
    } catch {
      setFailed(true) // no WebGL: the coordinate fields still work
      return
    }
    map.current = m
    if (editable) {
      m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
      m.on('click', (e) => {
        const p = e.lngLat.wrap()
        pick.current?.(p.lat, p.lng)
      })
    }
    return () => {
      marker.current?.remove()
      marker.current = null
      m.remove()
      map.current = null
    }
  }, [editable])

  // The pin follows the value.
  const lat = value?.lat
  const lng = value?.lng
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (lat === undefined || lng === undefined) {
      marker.current?.remove()
      marker.current = null
      return
    }
    if (!marker.current) {
      const pin = new Marker({ draggable: editable }).setLngLat([lng, lat]).addTo(m)
      pin.getElement().setAttribute('aria-label', 'Event pin')
      if (editable) {
        pin.on('dragend', () => {
          const p = pin.getLngLat().wrap()
          pick.current?.(p.lat, p.lng)
        })
      }
      marker.current = pin
    } else {
      marker.current.setLngLat([lng, lat])
    }
    if (!m.getBounds().contains([lng, lat])) m.easeTo({ center: [lng, lat], zoom: Math.max(m.getZoom(), MAP_PIN_ZOOM) })
  }, [lat, lng, editable])

  if (failed) return <p className="odz-muted">The map could not start on this device. Use the coordinates below.</p>
  return (
    <div
      ref={box}
      role={editable ? 'application' : 'img'}
      aria-label={editable ? 'Map. Tap to drop the event pin, drag the pin to move it.' : 'Map showing the event location'}
      style={{ height, width: '100%', borderRadius: 4, overflow: 'hidden' }}
    />
  )
}
