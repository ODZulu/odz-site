import type { ReactNode } from 'react'

/**
 * A small markdown renderer that builds React elements directly: there is no HTML string and no
 * dangerouslySetInnerHTML, so raw HTML and scripts come out as inert text. Supported: headings,
 * paragraphs, bold, italic, inline code, code blocks, lists, block quotes, rules and http(s)/mailto
 * links. Images are never rendered (no remote content); other URL schemes are dropped to plain text.
 * Used for minutes, documents and event descriptions (MVA-201, MVA-202).
 */

export type Heading = { level: number; text: string; id: string }

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim()
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'code'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'rule' }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', text: body.join(' ') })
      continue
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const ordered = /\d/.test(li[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m || /\d/.test(m[1]) !== ordered) break
        items.push(m[2])
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const body: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(```|#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])
    ) {
      body.push(lines[i++].trim())
    }
    blocks.push({ type: 'para', text: body.join(' ') })
  }
  return blocks
}

const INLINE = /(!\[[^\]]*\]\([^)]*\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)]+\))/g

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const tok = m[0]
    const key = `${keyBase}-${n++}`
    if (m[1]) {
      out.push(/^!\[([^\]]*)\]/.exec(tok)?.[1] ?? '') // images are never rendered
    } else if (m[2]) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>)
    } else if (m[3]) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    } else if (m[4]) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    } else if (m[5]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      const label = link?.[1] ?? tok
      const url = (link?.[2] ?? '').trim()
      out.push(
        SAFE_LINK.test(url) ? (
          <a key={key} href={url} rel="noopener noreferrer nofollow" target="_blank">
            {label}
          </a>
        ) : (
          label
        ),
      )
    }
    last = at + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Headings in order, with the ids the renderer gives them (for a table of contents). */
export function markdownHeadings(src: string): Heading[] {
  const seen = new Map<string, number>()
  return parseBlocks(src)
    .filter((b): b is Extract<Block, { type: 'heading' }> => b.type === 'heading')
    .map((b) => {
      const base = slug(stripInline(b.text))
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return { level: b.level, text: stripInline(b.text), id: n === 0 ? base : `${base}-${n + 1}` }
    })
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source)
  const heads = markdownHeadings(source)
  let h = 0
  return (
    <div className="odz-md">
      {blocks.map((b, i) => {
        const key = `b${i}`
        switch (b.type) {
          case 'heading': {
            const id = heads[h++]?.id
            const Tag = `h${Math.min(6, b.level + 1)}` as 'h2'
            return (
              <Tag key={key} id={id}>
                {inline(b.text, key)}
              </Tag>
            )
          }
          case 'para':
            return <p key={key}>{inline(b.text, key)}</p>
          case 'code':
            return (
              <pre key={key}>
                <code>{b.text}</code>
              </pre>
            )
          case 'quote':
            return <blockquote key={key}>{inline(b.text, key)}</blockquote>
          case 'rule':
            return <hr key={key} />
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={key}>
                {b.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </Tag>
            )
          }
        }
      })}
    </div>
  )
}
