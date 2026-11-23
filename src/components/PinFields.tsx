import { lazy, Suspense, useState } from 'react'
import { parseCoordinates, roundCoord } from '../lib/geo'
import { Button } from './Button'
import { Field } from './Field'

// The map is its own chunk: it loads only when an event form is opened.
const PinMap = lazy(() => import('./PinMap'))

type Patch = { latitude?: string; longitude?: string; hide_from_public_map?: boolean }

/**
 * The event location pin (MVA-224): a map to tap or click, a draggable pin, and the two coordinate
 * fields underneath (typed, or from the phone's location), all writing the same two values. The
 * fields stay the source of truth, so the form, validation and database are the same with or
 * without the map (and the fields still work if the map cannot start).
 */
export function PinFields({
  latitude, longitude, hidden, error, onChange,
}: {
  latitude: string
  longitude: string
  hidden: boolean
  error?: string
  onChange: (patch: Patch) => void
}) {
  const [locating, setLocating] = useState<string | null>(null)
  const has = latitude.trim() !== '' || longitude.trim() !== ''
  const pin = parseCoordinates(latitude, longitude)

  function useMyLocation() {
    if (!('geolocation' in navigator)) return setLocating('This device cannot give a location.')
    setLocating('Finding your location')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        onChange({ latitude: roundCoord(p.coords.latitude), longitude: roundCoord(p.coords.longitude) })
        setLocating(null)
      },
      () => setLocating('Could not get your location. Type the coordinates instead.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="odz-label">Map pin (optional, members only)</legend>
      <div className="odz-stack">
        <Suspense fallback={<p className="odz-muted" role="status">Loading map</p>}>
          <PinMap
            value={pin.ok ? pin.value : null}
            editable
            onPick={(la, lo) => onChange({ latitude: roundCoord(la), longitude: roundCoord(lo) })}
          />
        </Suspense>
        <Field label="Latitude" inputMode="decimal" value={latitude} onChange={(e) => onChange({ latitude: e.target.value })} error={error} />
        <Field label="Longitude" inputMode="decimal" value={longitude} onChange={(e) => onChange({ longitude: e.target.value })} />
        <div className="odz-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button small variant="sec" onClick={useMyLocation}>
            Use my location
          </Button>
          {has && (
            <Button small variant="ghost" onClick={() => onChange({ latitude: '', longitude: '' })}>
              Remove pin
            </Button>
          )}
        </div>
        {locating && <p className="odz-muted" role="status">{locating}</p>}
        {pin.ok && pin.value && <p className="odz-muted">Pin set at {pin.value.lat}, {pin.value.lng}.</p>}
        <label className="odz-row" style={{ gap: '0.5rem', minHeight: '2.5rem' }}>
          <input type="checkbox" checked={hidden} onChange={(e) => onChange({ hide_from_public_map: e.target.checked })} />
          Keep off the public map
        </label>
      </div>
    </fieldset>
  )
}
