import { Navigate, Route, Routes } from 'react-router'
import { Gate } from './auth/Gate'
import { AppShell, GateLayout, PublicFrame } from './components'
import { useAuth } from './auth/AuthProvider'
import { homeFor } from './lib/access'
import Calendar from './pages/Calendar'
import AdminLayout from './pages/admin/AdminLayout'
import Audit from './pages/admin/Audit'
import Invites from './pages/admin/Invites'
import Members from './pages/admin/Members'
import PendingQueue from './pages/admin/Pending'
import Tiers from './pages/admin/Tiers'
import { Denied, Pending } from './pages/Holding'
import DocumentDetail from './pages/DocumentDetail'
import DocumentEdit from './pages/DocumentEdit'
import Documents from './pages/Documents'
import Hq from './pages/Hq'
import Join from './pages/Join'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Me from './pages/Me'
import Minutes from './pages/Minutes'
import MinutesDetail from './pages/MinutesDetail'
import MinutesEdit from './pages/MinutesEdit'
import Roster from './pages/Roster'
import RosterDetail from './pages/RosterDetail'
import Setup from './pages/Setup'

/** The calendar is public: signed-in members get the full shell, everyone else the public frame. */
function CalendarRoute() {
  const { access } = useAuth()
  if (access.loading) return null
  return homeFor(access) === '/hq' ? (
    <AppShell>
      <Calendar />
    </AppShell>
  ) : (
    <PublicFrame>
      <Calendar />
    </PublicFrame>
  )
}

/**
 * `/join` is reachable only by an invite link and is linked from nowhere (MVA-199). Everything
 * in the app proper sits behind the access gate; unknown paths send signed-out visitors to login.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/calendar" element={<CalendarRoute />} />
      <Route element={<GateLayout />}>
        <Route path="/login" element={<Login />} />
        <Route path="/join/:code?" element={<Join />} />
        <Route element={<Gate page="setup" />}>
          <Route path="/setup" element={<Setup />} />
        </Route>
        <Route element={<Gate page="pending" />}>
          <Route path="/pending" element={<Pending />} />
        </Route>
        <Route element={<Gate page="denied" />}>
          <Route path="/denied" element={<Denied />} />
        </Route>
      </Route>
      <Route element={<Gate page="app" />}>
        <Route element={<AppShell />}>
          <Route path="/hq" element={<Hq />} />
          <Route path="/roster" element={<Roster />} />
          <Route path="/roster/:callsign" element={<RosterDetail />} />
          <Route path="/me" element={<Me />} />
          <Route path="/minutes" element={<Minutes />} />
          <Route path="/minutes/new" element={<MinutesEdit />} />
          <Route path="/minutes/:id" element={<MinutesDetail />} />
          <Route path="/minutes/:id/edit" element={<MinutesEdit />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/documents/new" element={<DocumentEdit />} />
          <Route path="/documents/edit/:id" element={<DocumentEdit />} />
          <Route path="/documents/:slug" element={<DocumentDetail />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route path="invites" element={<Invites />} />
            <Route path="pending" element={<PendingQueue />} />
            <Route path="members" element={<Members />} />
            <Route path="tiers" element={<Tiers />} />
            <Route path="audit" element={<Audit />} />
          </Route>
          <Route path="/members" element={<Navigate to="/roster" replace />} />
          <Route path="*" element={<h1 className="odz-title">Not found</h1>} />
        </Route>
      </Route>
    </Routes>
  )
}
