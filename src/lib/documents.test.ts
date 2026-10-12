import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

import { groupBySlug, groupByType, slugify, validateDocument, type DocInput, type DocSummary } from './documents'

const doc = (over: Partial<DocSummary>): DocSummary => ({
  id: Math.random().toString(36).slice(2),
  slug: 'fake',
  title: 'Fake',
  doc_type: 'Bylaws',
  version: '1.0',
  status: 'draft',
  effective_date: null,
  published: false,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
})

describe('groupBySlug', () => {
  it('uses the ratified version as current and lists the rest as previous', () => {
    const v1 = doc({ slug: 'b', version: '1.0', status: 'superseded', effective_date: '2026-01-01', published: true })
    const v2 = doc({ slug: 'b', version: '1.1', status: 'ratified', effective_date: '2026-06-01', published: true })
    const v3 = doc({ slug: 'b', version: '1.2', status: 'draft' })
    const [g] = groupBySlug([v1, v3, v2])
    expect(g.current.version).toBe('1.1')
    expect(g.previous.map((d) => d.version).sort()).toEqual(['1.0', '1.2'])
  })
  it('falls back to the newest when nothing is ratified', () => {
    const a = doc({ slug: 'x', version: '0.1', created_at: '2026-10-01T00:00:00Z' })
    const b = doc({ slug: 'x', version: '0.2', created_at: '2026-10-02T00:00:00Z' })
    expect(groupBySlug([a, b])[0].current.version).toBe('0.2')
  })
  it('keeps one entry per slug, sorted by title', () => {
    const groups = groupBySlug([doc({ slug: 'z', title: 'Zed' }), doc({ slug: 'a', title: 'Alpha' })])
    expect(groups.map((g) => g.slug)).toEqual(['a', 'z'])
  })
})

describe('groupByType', () => {
  it('follows the display order and drops empty types', () => {
    const groups = groupBySlug([
      doc({ slug: 'a', doc_type: 'Other' }),
      doc({ slug: 'b', doc_type: 'Bylaws' }),
      doc({ slug: 'c', doc_type: 'Doctrine' }),
    ])
    expect(groupByType(groups).map((t) => t.type)).toEqual(['Bylaws', 'Doctrine', 'Other'])
  })
})

describe('validateDocument', () => {
  const good: DocInput = {
    slug: 'fake-bylaws',
    title: 'Fake Bylaws',
    doc_type: 'Bylaws',
    version: '1.0',
    status: 'draft',
    effective_date: '',
    body_md: '# Fake',
    published: false,
  }
  it('accepts a good draft', () => expect(validateDocument(good, true)).toEqual({}))
  it('needs a clean slug when creating only', () => {
    expect(validateDocument({ ...good, slug: 'Bad Slug' }, true).slug).toBeDefined()
    expect(validateDocument({ ...good, slug: 'Bad Slug' }, false).slug).toBeUndefined()
  })
  it('does not allow publishing a draft', () => expect(validateDocument({ ...good, published: true }, true).published).toBeDefined())
  it('needs a title and a version', () => {
    const e = validateDocument({ ...good, title: ' ', version: '' }, true)
    expect(Object.keys(e).sort()).toEqual(['title', 'version'])
  })
})

describe('slugify', () => {
  it('makes a url-safe slug', () => expect(slugify('  Fake Bylaws, Rev. 2! ')).toBe('fake-bylaws-rev-2'))
})
