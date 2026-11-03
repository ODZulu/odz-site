import { Chip, Panel, Table } from '../components'
import { isVacant } from '../lib/designations'
import { supabase } from '../lib/supabase'
import { useLoad } from '../lib/useLoad'

type OverviewRow = {
  id: string
  name: string
  description: string
  office_seat: boolean
  max_holders: number
  holder_count: number
}

/**
 * The Vacant list (MVA-220): every designation, its holder count against its cap, and whether it
 * is vacant. Visible to Admin, edit_roster holders, and any seat holder (Old Guard or Command);
 * the database is the actual gate, this page just shows a quiet message to anyone else.
 */
export default function Designations() {
  const overview = useLoad(async () => {
    const { data, error } = await supabase!.rpc('designations_overview')
    if (error) return null
    return data as OverviewRow[]
  })

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Designations
      </h1>
      <Panel title="Duty roles">
        {overview.loading ? (
          <p className="odz-muted" role="status">
            Loading
          </p>
        ) : !overview.data ? (
          <p className="odz-muted">Visible to Old Guard and Command.</p>
        ) : (
          <Table
            rows={overview.data}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Designation', render: (r) => r.name },
              { header: 'Description', render: (r) => r.description },
              { header: 'Holders', render: (r) => `${r.holder_count}/${r.max_holders}` },
              { header: 'Status', render: (r) => (isVacant(r.holder_count) ? <Chip variant="pending">Vacant</Chip> : '') },
            ]}
          />
        )}
      </Panel>
    </>
  )
}
