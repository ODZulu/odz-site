import { storagePath, validateUpload, MAX_FILES_PER_MINUTES } from './files'
import { supabase } from './supabase'

/** Data access for minutes and their files (MVA-202). Files live in a private bucket; reads use short-lived signed URLs. */

export type MinutesStatus = 'draft' | 'published'

export type MinutesSummary = { id: string; title: string; meeting_date: string; status: MinutesStatus }
export type MinutesFile = { id: string; storage_path: string; filename: string; mime_type: string; size_bytes: number; created_at: string }
export type MinutesFull = MinutesSummary & { body_md: string | null; files: MinutesFile[] }
export type MinutesInput = { title: string; meeting_date: string; body_md: string; status: MinutesStatus }

const BUCKET = 'minutes'

export type MinutesErrors = Partial<Record<keyof MinutesInput, string>>

export function validateMinutes(v: MinutesInput): MinutesErrors {
  const e: MinutesErrors = {}
  if (v.title.trim() === '') e.title = 'Title is required.'
  else if (v.title.trim().length > 160) e.title = 'Title is too long.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.meeting_date)) e.meeting_date = 'Enter the meeting date.'
  if (v.body_md.length > 200_000) e.body_md = 'The notes are too long.'
  return e
}

export async function listMinutes(): Promise<MinutesSummary[]> {
  const { data, error } = await supabase!.from('minutes').select('id,title,meeting_date,status').order('meeting_date', { ascending: false })
  if (error) throw new Error('minutes')
  return data as MinutesSummary[]
}

export async function getMinutes(id: string): Promise<MinutesFull | null> {
  const { data, error } = await supabase!
    .from('minutes')
    .select('id,title,meeting_date,status,body_md,files:minutes_files(id,storage_path,filename,mime_type,size_bytes,created_at)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error('minutes')
  return (data as unknown as MinutesFull | null) ?? null
}

/** Creates (id null) or updates. Returns the id. */
export async function saveMinutes(id: string | null, v: MinutesInput): Promise<string> {
  const row = { title: v.title.trim(), meeting_date: v.meeting_date, body_md: v.body_md.trim() || null, status: v.status }
  if (id) {
    const { error } = await supabase!.from('minutes').update(row).eq('id', id)
    if (error) throw new Error('minutes')
    return id
  }
  const { data, error } = await supabase!.from('minutes').insert(row).select('id').single()
  if (error || !data) throw new Error('minutes')
  return (data as { id: string }).id
}

export async function deleteMinutes(id: string): Promise<void> {
  const files = await getMinutes(id)
  if (files && files.files.length > 0) {
    await supabase!.storage.from(BUCKET).remove(files.files.map((f) => f.storage_path))
  }
  const { error } = await supabase!.from('minutes').delete().eq('id', id)
  if (error) throw new Error('minutes')
}

export type UploadResult = { ok: true } | { ok: false; reason: string }

export async function uploadMinutesFile(minutesId: string, file: File, existingCount: number): Promise<UploadResult> {
  if (existingCount >= MAX_FILES_PER_MINUTES) return { ok: false, reason: `At most ${MAX_FILES_PER_MINUTES} files per set of minutes.` }
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const check = validateUpload(file, head)
  if (!check.ok) return check
  const path = storagePath(minutesId, crypto.randomUUID(), file.name)
  const up = await supabase!.storage.from(BUCKET).upload(path, file, { contentType: check.mime, upsert: false })
  if (up.error) return { ok: false, reason: 'The upload failed.' }
  const ins = await supabase!
    .from('minutes_files')
    .insert({ minutes_id: minutesId, storage_path: path, filename: file.name.slice(0, 200), mime_type: check.mime, size_bytes: file.size })
  if (ins.error) {
    await supabase!.storage.from(BUCKET).remove([path])
    return { ok: false, reason: 'The upload failed.' }
  }
  return { ok: true }
}

export async function removeMinutesFile(f: MinutesFile): Promise<void> {
  await supabase!.storage.from(BUCKET).remove([f.storage_path])
  const { error } = await supabase!.from('minutes_files').delete().eq('id', f.id)
  if (error) throw new Error('minutes')
}

/** A link that works for one minute. Never stored or logged. */
export async function signedUrl(f: Pick<MinutesFile, 'storage_path'>): Promise<string | null> {
  const { data, error } = await supabase!.storage.from(BUCKET).createSignedUrl(f.storage_path, 60)
  return error || !data ? null : data.signedUrl
}

/** Reads a validated TXT or MD file as text for "Import as body". */
export async function readTextFile(file: File): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const check = validateUpload(file, head)
  if (!check.ok) return check
  if (check.kind !== 'txt' && check.kind !== 'md') return { ok: false, reason: 'Only TXT and MD files can be imported as the body.' }
  const text = await file.text()
  if (text.length > 200_000) return { ok: false, reason: 'That file is too long to import.' }
  return { ok: true, text }
}
