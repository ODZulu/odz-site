/**
 * Splash hero logo rotation (MVA-244). The indexing and timing decisions are pure functions so
 * they can be tested without a DOM; `useLogoRotation` just wires them to a timer and to
 * prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from 'react'

export const LOGO_INTERVAL_MS = 6000
export const LOGO_FADE_MS = 600

/** A starting logo chosen at random, 0 <= i < count. `rand` is injectable for deterministic tests. */
export function randomLogoIndex(count: number, rand: () => number = Math.random): number {
  return Math.floor(rand() * count)
}

/** The next logo in rotation; wraps back to 0 after the last one. */
export function nextLogoIndex(current: number, count: number): number {
  return (current + 1) % count
}

function reducedMotionPreferred(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Index of the logo to show. With prefers-reduced-motion it is chosen once at random and never
 * advances. Otherwise it alternates every LOGO_INTERVAL_MS, pausing while the tab is hidden, and
 * always clears its timer on unmount.
 */
export function useLogoRotation(count: number): number {
  const reduced = useRef(reducedMotionPreferred()).current
  const [index, setIndex] = useState(() => randomLogoIndex(count))

  useEffect(() => {
    if (reduced || count < 2) return
    let id: ReturnType<typeof setInterval> | undefined
    const tick = () => setIndex((i) => nextLogoIndex(i, count))
    const start = () => {
      if (id === undefined) id = setInterval(tick, LOGO_INTERVAL_MS)
    }
    const stop = () => {
      if (id !== undefined) {
        clearInterval(id)
        id = undefined
      }
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced, count])

  return index
}
