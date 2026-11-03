import { describe, expect, it } from 'vitest'
import { nextLogoIndex, randomLogoIndex } from './logoRotation'

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
