import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesignationBadges } from './DesignationBadges'

describe('DesignationBadges', () => {
  it('renders nothing when a member holds none', () => {
    expect(renderToStaticMarkup(<DesignationBadges names={[]} />)).toBe('')
  })

  it('renders a badge per designation held', () => {
    const html = renderToStaticMarkup(<DesignationBadges names={['Treasurer', 'Quartermaster']} />)
    expect(html).toContain('Treasurer')
    expect(html).toContain('Quartermaster')
  })
})
