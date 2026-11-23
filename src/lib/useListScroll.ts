import { useEffect } from 'react'
import { useNavigationType } from 'react-router'

const read = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // storage can be blocked; the list then just opens at the top
  }
}

/**
 * Back from an event page returns to the list where it was (MVA-301). The position is saved as the
 * list unmounts and put back once `ready` (the rows are in) when the visit is a Back or Forward; a
 * fresh visit starts at the top. Storage that is blocked just means no restore.
 */
export function useListScroll(key: string, ready: boolean) {
  const type = useNavigationType()
  useEffect(() => {
    if (!ready || type !== 'POP') return
    const y = Number(read(`scroll:${key}`))
    if (y > 0) window.scrollTo(0, y)
  }, [key, ready, type])
  useEffect(() => {
    return () => write(`scroll:${key}`, String(window.scrollY))
  }, [key])
}

/** A boolean (such as "Past events is open") that survives leaving the list and coming Back. */
export function readFlag(key: string): boolean {
  return read(`flag:${key}`) === '1'
}
export function saveFlag(key: string, on: boolean) {
  write(`flag:${key}`, on ? '1' : '0')
}
