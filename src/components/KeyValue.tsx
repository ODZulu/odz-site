import type { ReactNode } from 'react'

export function KeyValue({ items }: { items: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className="odz-kv">
      {items.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
