import { useEffect, useState } from 'react'

/** Mobile layout: 760px and below (MVA-297). Keep in step with the media query in design/odz.css. */
export const MOBILE_QUERY = '(max-width: 47.5rem)'

/** Tracks a CSS media query. Without `matchMedia` (tests, server) it answers `fallback`. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const read = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : fallback)
  const [matches, setMatches] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}
