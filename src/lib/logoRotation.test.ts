import { describe, expect, it } from 'vitest'
import { LOGO_FADE_MS, LOGO_INTERVAL_MS, LOGO_ROTATE_DEG, logoStyle, nextLogoIndex, randomLogoIndex } from './logoRotation'

describe('randomLogoIndex', () => {
  it('picks a starting logo in range', () => {
    expect(randomLogoIndex(2, () => 0)).toBe(0)
    expect(randomLogoIndex(2, () => 0.9999)).toBe(1)
    expect(randomLogoIndex(3, () => 0.5)).toBe(1)
  })
})

describe('nextLogoIndex', () => {
  it('alternates between two logos', () => {
    expect(nextLogoIndex(0, 2)).toBe(1)
    expect(nextLogoIndex(1, 2)).toBe(0)
  })
  it('wraps back to the first logo after the last', () => {
    expect(nextLogoIndex(2, 3)).toBe(0)
  })
})

describe('rotation constants (MVA-250)', () => {
  it('fades for 900 ms, which is 50% longer than the old 600 ms, and the swap interval is unchanged', () => {
    expect(LOGO_FADE_MS).toBe(900)
    expect(LOGO_FADE_MS).toBe(600 * 1.5)
    expect(LOGO_INTERVAL_MS).toBe(6000)
    expect(LOGO_FADE_MS).toBeLessThan(LOGO_INTERVAL_MS)
  })
  it('rotates the incoming mark by 8 to 12 degrees', () => {
    expect(LOGO_ROTATE_DEG).toBeGreaterThanOrEqual(8)
    expect(LOGO_ROTATE_DEG).toBeLessThanOrEqual(12)
  })
})

describe('logoStyle', () => {
  it('fades the outgoing mark and rotates the incoming one in over the fade time, opacity and transform only', () => {
    const incoming = logoStyle(true, false, true)
    const outgoing = logoStyle(false, false, true)
    expect(incoming.opacity).toBe(1)
    expect(outgoing.opacity).toBe(0)
    expect(incoming.animation).toBe(`odz-logo-in ${LOGO_FADE_MS}ms ease-out`)
    expect(outgoing.animation).toBe('none')
    expect(incoming.transition).toBe(`opacity ${LOGO_FADE_MS}ms ease-in-out`)
    expect(incoming['--odz-logo-rotate']).toBe(`${LOGO_ROTATE_DEG}deg`)
    // Nothing else (no width, margin, position...) can move the layout.
    expect(Object.keys(incoming).sort()).toEqual(['--odz-logo-rotate', 'animation', 'opacity', 'transition'])
  })
  it('does not animate the first mark on page load, only swaps', () => {
    expect(logoStyle(true, false, false).animation).toBe('none')
  })
  it('is static under prefers-reduced-motion: no transition and no animation', () => {
    for (const active of [true, false]) {
      const s = logoStyle(active, true, true)
      expect(s.transition).toBe('none')
      expect(s.animation).toBe('none')
    }
    expect(logoStyle(true, true, true).opacity).toBe(1)
    expect(logoStyle(false, true, true).opacity).toBe(0)
  })
})
