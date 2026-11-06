import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TreasuryAccessPanel } from './TreasuryAccessPanel'

vi.mock('../lib/supabase', () => ({ supabase: null }))

const render = (on: boolean) => renderToStaticMarkup(<TreasuryAccessPanel on={on} onDone={() => {}} />)

describe('TreasuryAccessPanel', () => {
  it('when off, shows the state and a turn-on button with no confirm step', () => {
    const html = render(false)
    expect(html).toContain('OFF')
    expect(html).toContain('Only Admins can use the treasury')
    expect(html).toContain('Turn member access on')
    expect(html).not.toContain('Turn member access off')
  })

  it('when on, explains what members lose and offers a two-step turn-off', () => {
    const html = render(true)
    expect(html).toContain('ON')
    expect(html).toContain('members lose their balance')
    expect(html).toContain('Turn member access off')
    expect(html).not.toContain('Confirm: turn off')
    expect(html).not.toContain('Turn member access on')
  })
})
