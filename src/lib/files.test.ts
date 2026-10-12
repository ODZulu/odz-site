import { describe, expect, it } from 'vitest'
import { extensionOf, formatSize, MAX_BYTES, safeFileName, sniff, storagePath, validateUpload } from './files'

const bytes = (...b: number[]) => new Uint8Array(b)
const text = (s: string) => new TextEncoder().encode(s)
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34)
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00)

describe('extensionOf', () => {
  it('accepts the four types, case-insensitively', () => {
    expect(extensionOf('Notes.PDF')).toBe('pdf')
    expect(extensionOf('a.b.md')).toBe('md')
    expect(extensionOf('x.docx')).toBe('docx')
    expect(extensionOf('x.txt')).toBe('txt')
  })
  it('rejects everything else', () => {
    for (const n of ['run.exe', 'page.html', 'noext', 'archive.zip', 'x.pdf.exe', 'x.']) expect(extensionOf(n)).toBeNull()
  })
})

describe('sniff', () => {
  it('recognises pdf and zip', () => {
    expect(sniff(PDF)).toBe('pdf')
    expect(sniff(ZIP)).toBe('zip')
  })
  it('treats plain UTF-8 as text', () => {
    expect(sniff(text('# Notes\n\nplain text, accents: café'))).toBe('text')
  })
  it('tolerates a multi-byte character cut off at the end of the sample', () => {
    const full = text('café')
    expect(sniff(full.slice(0, full.length - 1))).toBe('text')
  })
  it('treats NUL bytes and invalid UTF-8 as unknown', () => {
    expect(sniff(bytes(0x68, 0x00, 0x69))).toBe('unknown')
    expect(sniff(bytes(0xff, 0xfe, 0xfd))).toBe('unknown')
    expect(sniff(bytes())).toBe('unknown')
  })
})

describe('validateUpload', () => {
  it('accepts matching content', () => {
    expect(validateUpload({ name: 'a.pdf', size: 100 }, PDF)).toMatchObject({ ok: true, kind: 'pdf', mime: 'application/pdf' })
    expect(validateUpload({ name: 'a.docx', size: 100 }, ZIP)).toMatchObject({ ok: true, kind: 'docx' })
    expect(validateUpload({ name: 'a.md', size: 10 }, text('# hi'))).toMatchObject({ ok: true, mime: 'text/markdown' })
    expect(validateUpload({ name: 'a.txt', size: 10 }, text('hi'))).toMatchObject({ ok: true, mime: 'text/plain' })
  })
  it('rejects a disguised executable whatever the name says', () => {
    const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03)
    for (const name of ['a.pdf', 'a.docx', 'a.txt', 'a.md']) {
      expect(validateUpload({ name, size: 100 }, exe)).toMatchObject({ ok: false })
    }
  })
  it('rejects a script renamed to .pdf, and a pdf renamed to .txt', () => {
    expect(validateUpload({ name: 'a.pdf', size: 10 }, text('<script>alert(1)</script>'))).toMatchObject({ ok: false })
    expect(validateUpload({ name: 'a.txt', size: 10 }, PDF)).toMatchObject({ ok: false })
  })
  it('rejects unknown extensions, empty files and files over 10 MB', () => {
    expect(validateUpload({ name: 'a.exe', size: 10 }, text('x'))).toMatchObject({ ok: false })
    expect(validateUpload({ name: 'a.txt', size: 0 }, text('x'))).toMatchObject({ ok: false })
    expect(validateUpload({ name: 'a.pdf', size: MAX_BYTES + 1 }, PDF)).toMatchObject({ ok: false })
    expect(validateUpload({ name: 'a.pdf', size: MAX_BYTES }, PDF)).toMatchObject({ ok: true })
  })
})

describe('names and paths', () => {
  it('makes a storage-safe name and keeps the extension', () => {
    expect(safeFileName('My Notes (final).PDF')).toBe('My_Notes_final_.PDF')
    expect(safeFileName('../../etc/passwd.txt')).toBe('passwd.txt')
    expect(safeFileName('...hidden.md')).toBe('hidden.md')
    expect(safeFileName(`${'a'.repeat(200)}.pdf`).length).toBeLessThanOrEqual(120)
    expect(safeFileName(`${'a'.repeat(200)}.pdf`).endsWith('.pdf')).toBe(true)
  })
  it('matches the shape the database and storage policy accept', () => {
    const id = '11111111-1111-1111-1111-111111111111'
    const path = storagePath(id, '22222222-2222-2222-2222-222222222222', 'A b.pdf')
    expect(path).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$/,
    )
  })
  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
