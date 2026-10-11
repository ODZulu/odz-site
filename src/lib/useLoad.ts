import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Runs an async loader on mount and whenever `reload()` is called. `loader` may close over props;
 * the latest one is always used. It also reruns when any value in `deps` changes. Errors become a fixed message, never the raw error text.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[] = []) {
  const ref = useRef(loader)
  ref.current = loader
  const [state, setState] = useState<{ data: T | null; loading: boolean; failed: boolean }>({
    data: null,
    loading: true,
    failed: false,
  })

  const reload = useCallback(async () => {
    try {
      const data = await ref.current()
      setState({ data, loading: false, failed: false })
    } catch {
      setState((s) => ({ ...s, loading: false, failed: true }))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, ...deps])

  return { ...state, reload }
}
