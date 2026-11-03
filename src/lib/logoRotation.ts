/**
 * Splash hero logo rotation (MVA-244). The indexing and timing decisions are pure functions so
 * they can be tested without a DOM; `useLogoRotation` just wires them to a timer and to
 * prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from 'react'

export const LOGO_INTERVAL_MS = 6000
/** Crossfade duration: 900 ms, 50% longer than the original 600 ms (MVA-250). */
export const LOGO_FADE_MS = 900
/** Incoming mark starts this many degrees turned and eases to 0 while it fades in (MVA-250: 8 to 12). */
export const LOGO_ROTATE_DEG = 10

/**
 * Opacity and transform only, so rotating never shifts the layout. Every mark is upright at rest
 * (equal bounding boxes); the incoming one plays the `odz-logo-in` keyframes (src/design/odz.css),
 * which start it turned by --odz-logo-rotate and ease it to 0 while it fades in. The outgoing one
 * just fades. Under prefers-reduced-motion nothing animates.
 */
export function logoStyle(active: boolean, reduced: boolean, entering: boolean) {
  return {
    opacity: active ? 1 : 0,
    transition: reduced ? 'none' : `opacity ${LOGO_FADE_MS}ms ease-in-out`,
    animation: !reduced && active && entering ? `odz-logo-in ${LOGO_FADE_MS}ms ease-out` : 'none',
    '--odz-logo-rotate': `${LOGO_ROTATE_DEG}deg`,
  }
}

/** A starting logo chosen at random, 0 <= i < count. `rand` is injectable for deterministic tests. */
export function randomLogoIndex(count: number, rand: () => number = Math.random): number {
  return Math.floor(rand() * count)
}

/** The next logo in rotation; wraps back to 0 after the last one. */
export function nextLogoIndex(current: number, count: number): number {
  return (current + 1) % count
}

export function reducedMotionPreferred(): boolean {
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
