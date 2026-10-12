import { supabase } from './supabase'

/** Data access for governance documents (MVA-202). The text lives in the database; nothing is bundled or public. */

export const DOC_TYPES = ['Bylaws', 'Doctrine', 'Role Charters', 'Onboarding SOP', 'Other'] as const
export type DocType = (typeof DOC_TYPES)[number]
export type DocStatus = 'draft' | 'ratified' | 'superseded'

export type DocSummary = {
  id: string
  slug: string
  title: string
  doc_type: DocType
  version: string
  status: DocStatus
  effective_date: string | null
  published: boolean
  created_at: string
}
export type DocFull = DocSummary & { body_md: string }
export type DocInput = {
  slug: string
  title: string
  doc_type: DocType
  version: string
  status: DocStatus
  effective_date: string
  body_md: string
  published: boolean
}

export type DocErrors = Partial<Record<keyof DocInput, string>>

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

export function validateDocument(v: DocInput, creating: boolean): DocErrors {
  const e: DocErrors = {}
  if (v.title.trim() === '') e.title = 'Title is required.'
  else if (v.title.trim().length > 160) e.title = 'Title is too long.'
  if (creating && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.slug)) e.slug = 'Use lowercase letters, digits and single dashes.'
  if (v.version.trim() === '' || v.version.trim().length > 30) e.version = 'Enter a version such as 1.0.'
  if (v.effective_date && !/^\d{4}-\d{2}-\d{2}$/.test(v.effective_date)) e.effective_date = 'Use a valid date.'
  if (v.status === 'draft' && v.published) e.published = 'A draft cannot be published.'
  if (v.body_md.length > 500_000) e.body_md = 'The text is too long.'
  return e
}

export type DocGroup = { slug: string; current: DocSummary; previous: DocSummary[] }

/**
 * One entry per slug: the ratified version if there is one, otherwise the newest. Everything else
 * is a previous version (superseded, or an unpublished draft that only publishers can see).
 */
export function groupBySlug(docs: DocSummary[]): DocGroup[] {
  const bySlug = new Map<string, DocSummary[]>()
  for (const d of docs) bySlug.set(d.slug, [...(bySlug.get(d.slug) ?? []), d])
  const newestFirst = (a: DocSummary, b: DocSummary) =>
    (b.effective_date ?? b.created_at).localeCompare(a.effective_date ?? a.created_at) || b.created_at.localeCompare(a.created_at)
  return [...bySlug.entries()]
    .map(([slug, list]) => {
      const sorted = [...list].sort(newestFirst)
      const current = sorted.find((d) => d.status === 'ratified') ?? sorted[0]
      return { slug, current, previous: sorted.filter((d) => d.id !== current.id) }
    })
    .sort((a, b) => a.current.title.localeCompare(b.current.title))
}

/** Groups document entries by type in the display order of DOC_TYPES. */
export function groupByType(groups: DocGroup[]): Array<{ type: DocType; groups: DocGroup[] }> {
  return DOC_TYPES.map((type) => ({ type, groups: groups.filter((g) => g.current.doc_type === type) })).filter((t) => t.groups.length > 0)
}

const SUMMARY = 'id,slug,title,doc_type,version,status,effective_date,published,created_at'

export async function listDocuments(): Promise<DocSummary[]> {
  const { data, error } = await supabase!.from('documents').select(SUMMARY)
  if (error) throw new Error('documents')
  return data as DocSummary[]
}

export async function getDocument(id: string): Promise<DocFull | null> {
  const { data, error } = await supabase!.from('documents').select(`${SUMMARY},body_md`).eq('id', id).maybeSingle()
  if (error) throw new Error('documents')
  return (data as DocFull | null) ?? null
}

export async function saveDocument(id: string | null, v: DocInput): Promise<string> {
  const base = {
    title: v.title.trim(),
    doc_type: v.doc_type,
    version: v.version.trim(),
    status: v.status,
    effective_date: v.effective_date || null,
    body_md: v.body_md,
    published: v.published,
  }
  if (id) {
    const { error } = await supabase!.from('documents').update(base).eq('id', id)
    if (error) throw new Error('documents')
    return id
  }
  const { data, error } = await supabase!.from('documents').insert({ ...base, slug: v.slug }).select('id').single()
  if (error || !data) throw new Error('documents')
  return (data as { id: string }).id
}

export async function deleteDocument(id: string): Promise<void> {
  const { error } = await supabase!.from('documents').delete().eq('id', id)
  if (error) throw new Error('documents')
}
