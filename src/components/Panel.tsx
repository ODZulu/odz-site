import type { ReactNode } from 'react'

type PanelProps = {
  title: string
  /** At most one small action or chip in the header. */
  action?: ReactNode
  children: ReactNode
}

export function Panel({ title, action, children }: PanelProps) {
  return (
    <section className="odz-panel">
      <div className="odz-panel__h">
        <h2 className="odz-label">{title}</h2>
        {action}
      </div>
      <div className="odz-panel__b">{children}</div>
    </section>
  )
}
