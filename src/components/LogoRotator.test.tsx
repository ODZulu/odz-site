import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LogoRotator } from './LogoRotator'

const logos = [
  { src: 'a.webp', alt: 'ODZ seal' },
  { src: 'b.webp', alt: 'ODZ general patch' },
]

describe('LogoRotator', () => {
  it('renders both marks with their alt text, each in the DOM from the start', () => {
    const html = renderToStaticMarkup(<LogoRotator logos={logos} />)
    expect(html).toContain('src="a.webp"')
    expect(html).toContain('src="b.webp"')
    expect(html).toContain('alt="ODZ seal"')
    expect(html).toContain('alt="ODZ general patch"')
  })

  it('shows exactly one logo at a time, the other at opacity 0 so it never shifts the layout', () => {
    const html = renderToStaticMarkup(<LogoRotator logos={logos} />)
    const opaque = html.match(/opacity:1/g) ?? []
    const hidden = html.match(/opacity:0/g) ?? []
    expect(opaque).toHaveLength(1)
    expect(hidden).toHaveLength(1)
  })

  it('puts every mark on the same round white backing at the same size (MVA-250)', () => {
    const html = renderToStaticMarkup(<LogoRotator logos={logos} />)
    expect(html).toContain('odz-logo-disc')
    const sizes = html.match(/width:100%;height:100%;object-fit:contain/g) ?? []
    expect(sizes).toHaveLength(2)
  })
})
