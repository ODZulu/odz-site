import { useState } from 'react'
import { LOGO_FADE_MS, useLogoRotation } from '../lib/logoRotation'

export type RotatingLogo = { src: string; alt: string }

type Props = {
  logos: readonly RotatingLogo[]
  className?: string
}

/**
 * Crossfades between the team's marks (MVA-244) inside a fixed box sized by `className`, so
 * rotating never shifts the layout. Both images are always in the DOM (never conditionally
 * rendered) so the browser loads them together. A mark that fails to load is never shown; the
 * other one stays up in its place instead of a broken-image icon.
 */
export function LogoRotator({ logos, className }: Props) {
  const active = useLogoRotation(logos.length)
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set())
  const shown = failed.has(active) ? logos.findIndex((_, i) => !failed.has(i)) : active

  return (
    <div className={className} style={{ position: 'relative' }}>
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
            opacity: i === shown ? 1 : 0,
            transition: `opacity ${LOGO_FADE_MS}ms ease`,
          }}
        />
      ))}
    </div>
  )
}
