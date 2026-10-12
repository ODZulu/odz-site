import type { ReactNode } from 'react'
import { cx } from './cx'

export type Column<T> = {
  header: string
  /** `cs` renders the callsign style; `status` right-aligns the cell on mobile cards. */
  kind?: 'cs' | 'status'
  render: (row: T) => ReactNode
}

type TableProps<T> = {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  selectedKey?: string
}

/** Table on desktop; stacked cards below 720px (see odz.css). */
export function Table<T>({ columns, rows, rowKey, selectedKey }: TableProps<T>) {
  return (
    <table className="odz-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.header} scope="col">
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row)
          return (
            <tr key={key} aria-selected={key === selectedKey ? true : undefined}>
              {columns.map((c) => (
                <td key={c.header} className={cx(c.kind)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
