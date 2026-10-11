/**
 * Upload checks for minutes files (MVA-202). The type is decided by the extension AND the file's
 * own first bytes, never by the MIME type the browser reports. The database and storage policies
 * repeat the extension, size and path rules; only the content sniff happens here.
 */

export const MAX_BYTES = 10 * 1024 * 1024
export const MAX_FILES_PER_MINUTES = 20

export type FileKind = 'pdf' | 'txt' | 'md' | 'docx'

export const KIND_MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export const ACCEPT = '.pdf,.txt,.md,.docx'

export function extensionOf(name: string): FileKind | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim())
  const ext = m?.[1].toLowerCase()
  return ext === 'pdf' || ext === 'txt' || ext === 'md' || ext === 'docx' ? ext : null
}

export type Sniffed = 'pdf' | 'zip' | 'text' | 'unknown'

export function sniff(head: Uint8Array): Sniffed {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf' // %PDF-
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'zip' // PK\x03\x04 (docx is a zip)
  if (head.length === 0) return 'unknown'
  if (head.includes(0)) return 'unknown' // NUL byte: binary, not text
  try {
    // stream: true tolerates a multi-byte character cut off at the end of the sample.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return 'text'
  } catch {
    return 'unknown'
  }
}

export type UploadCheck = { ok: true; kind: FileKind; mime: string } | { ok: false; reason: string }

/** `head` is the first few KB of the file. */
export function validateUpload(file: { name: string; size: number }, head: Uint8Array): UploadCheck {
  const kind = extensionOf(file.name)
  if (!kind) return { ok: false, reason: 'Only PDF, TXT, MD and DOCX files are accepted.' }
  if (file.size <= 0) return { ok: false, reason: 'That file is empty.' }
  if (file.size > MAX_BYTES) return { ok: false, reason: 'Files can be at most 10 MB.' }
  const seen = sniff(head)
  const matches =
    (kind === 'pdf' && seen === 'pdf') || (kind === 'docx' && seen === 'zip') || ((kind === 'txt' || kind === 'md') && seen === 'text')
  if (!matches) return { ok: false, reason: 'The file contents do not match its type.' }
  return { ok: true, kind, mime: KIND_MIME[kind] }
}

/** A storage-safe file name: letters, digits, dot, dash, underscore; at most 120 characters, extension kept. */
export function safeFileName(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/_{2,}/g, '_')
  const ext = /\.[A-Za-z0-9]+$/.exec(cleaned)?.[0] ?? ''
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned
  return `${(stem || 'file').slice(0, 120 - ext.length)}${ext}`
}

export function storagePath(minutesId: string, uuid: string, name: string): string {
  return `${minutesId}/${uuid}-${safeFileName(name)}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
