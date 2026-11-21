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
  // Every surface a text token can sit on. surface-hover is the worst case.
  const grounds = ['ground', 'deep', 'field', 'surface', 'surface-top', 'surface-raised', 'surface-hover']
  const textColors = ['ink', 'ink-muted', 'ink-subtle', 'primary', 'primary-soft', 'accent', 'go', 'pending', 'alert']
  for (const fg of textColors) {
    for (const bg of grounds) {
      it(`${fg} on ${bg}`, () => expect(contrast(color[fg], color[bg])).toBeGreaterThanOrEqual(4.5))
    }
  }
  it('ink-subtle keeps at least 4.8:1 on every surface (headroom if a surface or gradient shifts)', () => {
    for (const bg of grounds) expect(contrast(color['ink-subtle'], color[bg])).toBeGreaterThanOrEqual(4.8)
  })

  // Text on fills.
  const fills: Array<[string, string]> = [
    ['on-primary', 'primary'],
    ['on-primary', 'primary-soft'],
    ['on-accent', 'accent'],
    ['on-accent', 'alert'],
    ['on-primary', 'alert-fill'],
    ['on-tint-sage', 'tint-sage'],
    ['on-tint-sand', 'tint-sand'],
    ['on-tint-steel', 'tint-steel'],
    ['on-tint-clay', 'tint-clay'],
    ['on-tint-notice', 'tint-notice'],
  ]
  for (const [fg, bg] of fills) {
    it(`${fg} on ${bg}`, () => expect(contrast(color[fg], color[bg])).toBeGreaterThanOrEqual(4.5))
  }

  // Non-text: control borders and the focus ring need 3:1 on every surface.
  for (const bg of grounds) {
    it(`line-strong on ${bg} is 3:1+ (control borders)`, () =>
      expect(contrast(color['line-strong'], color[bg])).toBeGreaterThanOrEqual(3))
    it(`focus ring on ${bg} is 3:1+`, () => expect(contrast(color.focus, color[bg])).toBeGreaterThanOrEqual(3))
  }
})

describe('type floors (MVA-297)', () => {
  const css = readFileSync('src/design/odz.css', 'utf8')
  it('no font size under 12px (0.75rem) in component CSS', () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)rem/g)].map((m) => parseFloat(m[1]))
    expect(sizes.length).toBeGreaterThan(0)
    expect(sizes.filter((s) => s < 0.75)).toEqual([])
  })
  it('body text is at least 14px (0.875rem)', () => {
    const body = css.match(/--body-size:\s*([\d.]+)rem/)
    expect(body).not.toBeNull()
    expect(parseFloat((body as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(0.875)
  })
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
