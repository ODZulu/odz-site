import { readinessParts, readinessSummary, type Readiness } from '../lib/hq'

/** IN / TBD / OUT / no-response segments plus the counts in words, so colour is never the only signal. */
export function ReadinessMeter({ readiness }: { readiness: Readiness }) {
  const parts = readinessParts(readiness)
  const { text } = readinessSummary(readiness)
  return (
    <div>
      <div className="odz-meter" role="img" aria-label={`${text}. ${readiness.out_count} out, ${readiness.tbd_count} undecided, ${readiness.no_response} no response.`}>
        {parts.map((p) => (
          <span key={p.kind} className={p.kind} style={{ flex: p.count }} />
        ))}
      </div>
      <p className="odz-label" style={{ marginTop: '0.5rem' }}>
        {`${text}  ·  ${readiness.out_count} OUT  ·  ${readiness.tbd_count} TBD  ·  ${readiness.no_response} NO REPLY`}
      </p>
    </div>
  )
}
