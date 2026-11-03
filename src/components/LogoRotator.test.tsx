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
})
