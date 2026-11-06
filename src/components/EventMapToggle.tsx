import { lazy, Suspense, useState } from 'react'

const PinMap = lazy(() => import('./PinMap'))

/**
 * A small, non-interactive map of an event's pin on its card (MVA-224). Closed by default and loaded
 * only when opened, so a long calendar does not start a map (and a graphics context) per event.
 */
export function EventMapToggle({ lat, lng }: { lat: number; lng: number }) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Map</summary>
      {open && (
        <div style={{ margin: '0.5rem 0' }}>
          <Suspense fallback={<p className="odz-muted" role="status">Loading map</p>}>
            <PinMap value={{ lat, lng }} editable={false} height={160} />
          </Suspense>
        </div>
      )}
    </details>
  )
}
