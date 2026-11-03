import { Link } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Chip, KeyValue, Panel } from '../components'
import { loadTraffic, authorLabel } from '../lib/hq'
import type { ServiceEntry } from '../lib/service'
import { supabase } from '../lib/supabase'
import { formatStampPhoenix } from '../lib/time'
import { useLoad } from '../lib/useLoad'
import { ServiceRecordPanel } from './ServiceRecordPanel'

/**
 * Home for a retired account (MVA-238). A retired member keeps a limited sign-in: their own
 * profile, their service record (read-only), Traffic and notifications. Nothing else is reachable;
 * the database denies it as well (RLS), this page just does not offer it.
 */
export default function RetiredHome() {
  const { profile, session } = useAuth()
  const uid = session?.user.id
  const traffic = useLoad(() => loadTraffic(5))
  const service = useLoad<{ doe: string | null; entries: ServiceEntry[] } | null>(async () => {
    if (!supabase || !uid) return null
    const [rec, hist] = await Promise.all([
      supabase.from('service_records').select('doe').eq('profile_id', uid).maybeSingle(),
      supabase
        .from('service_history')
        .select('id,profile_id,event_date,title,location,role,notes,source')
        .eq('profile_id', uid),
    ])
    if (rec.error || hist.error) throw new Error('service')
    return { doe: (rec.data as { doe: string | null } | null)?.doe ?? null, entries: (hist.data ?? []) as ServiceEntry[] }
  }, [uid])

  return (
    <>
      <h1 className="odz-title" style={{ marginBottom: '1rem' }}>
        Retired
      </h1>
      <div className="odz-stack">
        <Panel title="Your account" action={<Chip variant="plain">RETIRED</Chip>}>
          <p style={{ marginBottom: '0.75rem' }}>
            You are retired from active play. You keep your profile, your service record and Traffic. To return, ask Command.
          </p>
          <KeyValue items={[['Callsign', profile?.callsign ?? '-']]} />
        </Panel>

        <Panel title="Traffic" action={<Link to="/traffic">More</Link>}>
          {traffic.loading ? (
            <p className="odz-muted" role="status">
              Loading
            </p>
          ) : traffic.failed ? (
            <p role="alert">Could not load traffic.</p>
          ) : (traffic.data?.posts ?? []).length === 0 ? (
            <p className="odz-muted">No traffic.</p>
          ) : (
            (traffic.data?.posts ?? []).map((p) => (
              <article key={p.id} className="odz-post">
                <span className="odz-label">{`${authorLabel(p.author)} · ${formatStampPhoenix(p.created_at)}`}</span>
                <h3 className="odz-post__title">{p.title}</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
              </article>
            ))
          )}
        </Panel>

        {uid && service.data && (
          <ServiceRecordPanel profileId={uid} doe={service.data.doe} entries={service.data.entries} canEdit={false} onChange={() => {}} />
        )}
      </div>
    </>
  )
}
