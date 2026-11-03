import { useRef, useState, type CSSProperties } from 'react'
import { logoStyle, reducedMotionPreferred, useLogoRotation } from '../lib/logoRotation'

export type RotatingLogo = { src: string; alt: string }

type Props = {
  logos: readonly RotatingLogo[]
  className?: string
}

/**
 * Crossfades between the team's marks (MVA-244, MVA-250) inside a fixed box sized by `className`, so
 * rotating never shifts the layout. Every mark sits in the same square, object-contain, on the same
 * round white backing (the general patch has a black ring that would vanish on the dark page);
 * artwork is never stretched, cropped or recolored (MVA-139). Both images are always in the DOM (never conditionally
 * rendered) so the browser loads them together. A mark that fails to load is never shown; the
 * other one stays up in its place instead of a broken-image icon.
 */
export function LogoRotator({ logos, className }: Props) {
  const active = useLogoRotation(logos.length)
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set())
  const reduced = useRef(reducedMotionPreferred()).current
  const shown = failed.has(active) ? logos.findIndex((_, i) => !failed.has(i)) : active
  // The first mark appears as the page loads without animating; every swap after that rotates in.
  const [seen, setSeen] = useState(shown)
  const [swapped, setSwapped] = useState(false)
  if (seen !== shown) {
    setSeen(shown)
    setSwapped(true)
  }

  return (
    <div className={`odz-logo-disc ${className ?? ''}`.trim()} style={{ position: 'relative' }}>
      {logos.map((logo, i) => (
        <img
          key={logo.src}
          src={logo.src}
          alt={logo.alt}
          aria-hidden={i === shown ? undefined : true}
          onError={() => setFailed((f) => new Set(f).add(i))}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            ...(logoStyle(i === shown, reduced, swapped) as CSSProperties),
          }}
        />
      ))}
    </div>
  )
}
