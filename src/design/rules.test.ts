import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import tokens from './tokens.json'

const color = Object.fromEntries(tokens.color.tokens.map((t) => [t.name, t.value]))

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('contrast (non-negotiable: text at least 4.5:1)', () => {
  const grounds = ['ground', 'surface', 'surface-raised', 'deep']
  const textColors = ['ink', 'ink-muted', 'primary', 'accent', 'go', 'pending', 'alert']
  for (const fg of textColors) {
    for (const bg of grounds) {
      it(`${fg} on ${bg}`, () => expect(contrast(color[fg], color[bg])).toBeGreaterThanOrEqual(4.5))
    }
  }
  it('on-primary on primary', () => expect(contrast(color['on-primary'], color.primary)).toBeGreaterThanOrEqual(4.5))
  it('on-accent on accent', () => expect(contrast(color['on-accent'], color.accent)).toBeGreaterThanOrEqual(4.5))
  it('on-accent on the filled alert chip', () => expect(contrast(color['on-accent'], color.alert)).toBeGreaterThanOrEqual(4.5))
  for (const bg of ['ground', 'surface']) {
    it(`line-strong on ${bg} is 3:1+ (control borders)`, () =>
      expect(contrast(color['line-strong'], color[bg])).toBeGreaterThanOrEqual(3))
    it(`focus ring on ${bg} is 3:1+`, () => expect(contrast(color.focus, color[bg])).toBeGreaterThanOrEqual(3))
  }
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('source rules', () => {
  const src = walk('src').map((p) => p.split('\\').join('/'))
  const code = src.filter((p) => /\.(tsx?|css)$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'))

  it('no hard-coded hex colours outside src/design', () => {
    const offenders = code
      .filter((p) => !p.startsWith('src/design/'))
      .filter((p) => /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('no emoji in source', () => {
    const offenders = code.filter((p) => /\p{Extended_Pictographic}/u.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('no Google Fonts import and no px font sizes in component CSS', () => {
    const css = readFileSync('src/design/odz.css', 'utf8')
    expect(css).not.toMatch(/googleapis/)
    expect(css).not.toMatch(/font-size:\s*\d+px/)
  })
})
