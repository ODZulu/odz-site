import { describe, expect, it } from 'vitest'
import { initialsOf, tintOf } from './Avatar'

describe('Avatar helpers', () => {
  it('takes up to two letters or digits', () => {
    expect(initialsOf('Fake-Wolf')).toBe('FW')
    expect(initialsOf('Fake')).toBe('FA')
    expect(initialsOf('E2E-R1Q58Y76')).toBe('ER')
    expect(initialsOf('---')).toBe('?')
  })
  it('gives the same name the same tint, always one of the four', () => {
    expect(tintOf('Fake-Wolf')).toBe(tintOf('Fake-Wolf'))
    expect(['sage', 'sand', 'steel', 'clay']).toContain(tintOf('Fake-Wolf'))
  })
})
