import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Chip, type ChipVariant } from './Chip'

const text = (html: string) => html.replace(/<[^>]+>/g, '').trim()

describe('Chip', () => {
  it.each<ChipVariant>(['go', 'pending', 'alert'])('status chip "%s" always renders a word', (variant) => {
    expect(text(renderToStaticMarkup(<Chip variant={variant} />))).not.toBe('')
    expect(text(renderToStaticMarkup(<Chip variant={variant}>{''}</Chip>))).not.toBe('')
  })

  it('keeps a supplied word', () => {
    expect(text(renderToStaticMarkup(<Chip variant="alert">ABORT</Chip>))).toBe('ABORT')
  })

  it('alert uses the filled variant class', () => {
    expect(renderToStaticMarkup(<Chip variant="alert" />)).toContain('odz-chip--alert')
  })
})
