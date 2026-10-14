import { Panel } from './Panel'
import { seatLine, vacancyText, type SeatCounts } from '../lib/seats'

/** Seat counters and vacancies (MVA-234). Rendered only for accounts the database lets read them. */
export function SeatCounters({ counts }: { counts: SeatCounts }) {
  return (
    <Panel title="Seats">
      <p>{seatLine(counts)}</p>
      <p className="odz-muted">{vacancyText(counts)}</p>
    </Panel>
  )
}
