import { Navigate, Route, Routes } from 'react-router'
import { Gate } from './auth/Gate'
import { AppShell, GateLayout } from './components'
import Calendar from './pages/Calendar'
import AdminLayout from './pages/admin/AdminLayout'
import Audit from './pages/admin/Audit'
import Invites from './pages/admin/Invites'
import Members from './pages/admin/Members'
import PendingQueue from './pages/admin/Pending'
import Tiers from './pages/admin/Tiers'
import { Denied, Pending } from './pages/Holding'
import Hq from './pages/Hq'
import Join from './pages/Join'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Roster from './pages/Roster'
import Setup from './pages/Setup'

/**
 * `/join` is reachable only by an invite link and is linked from nowhere (MVA-199). Everything
 * in the app proper sits behind the access gate; unknown paths send signed-out visitors to login.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
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
          <Route path="/calendar" element={<Calendar />} />
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
