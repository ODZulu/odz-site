import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, markdownHeadings } from './markdown'

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} />)

describe('markdown rendering', () => {
  it('renders the basics', () => {
    const out = html('# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n1. a\n2. b')
    expect(out).toContain('<h2 id="title">Title</h2>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
    expect(out).toContain('<code>code</code>')
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(out).toContain('<ol><li>a</li><li>b</li></ol>')
  })

  it('keeps a script injection inert', () => {
    const out = html('Hello <script>alert(1)</script> world\n\n<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<script')
    expect(out).not.toMatch(/<img/)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('never renders javascript: or data: links as anchors', () => {
    const out = html('[bad](javascript:alert(1)) [worse](data:text/html;base64,xx) [ok](https://example.invalid)')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text')
    expect(out).toContain('<a href="https://example.invalid" rel="noopener noreferrer nofollow" target="_blank">ok</a>')
    expect(out).toContain('bad')
  })

  it('never renders images, remote or otherwise', () => {
    const out = html('![alt text](https://example.invalid/x.png) and ![](data:image/png;base64,xx)')
    expect(out).not.toMatch(/<img/)
    expect(out).toContain('alt text')
  })

  it('escapes attribute-breaking input in links and code', () => {
    const out = html('[x](https://example.invalid/"onmouseover="alert(1))\n\n```\n<b>raw</b>\n```')
    expect(out).not.toMatch(/\sonmouseover=/)
    expect(out).toContain('&quot;')
    expect(out).toContain('&lt;b&gt;raw&lt;/b&gt;')
  })

  it('treats raw HTML blocks as text', () => {
    expect(html('<div onclick="x()">hi</div>')).not.toContain('<div onclick')
  })
})

describe('markdownHeadings', () => {
  it('lists headings with unique ids', () => {
    const heads = markdownHeadings('# Intro\n\n## Rules\n\n## Rules\n\ntext\n\n### **Bold** one')
    expect(heads.map((h) => h.id)).toEqual(['intro', 'rules', 'rules-2', 'bold-one'])
    expect(heads.map((h) => h.level)).toEqual([1, 2, 2, 3])
    expect(heads[3].text).toBe('Bold one')
  })
  it('matches the ids the renderer emits', () => {
    const src = '# One\n\n# One'
    const out = html(src)
    for (const h of markdownHeadings(src)) expect(out).toContain(`id="${h.id}"`)
  })
})
