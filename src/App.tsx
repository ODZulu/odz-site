import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components'
import Calendar from './pages/Calendar'
import Hq from './pages/Hq'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Roster from './pages/Roster'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route element={<AppShell />}>
        <Route path="/hq" element={<Hq />} />
        <Route path="/roster" element={<Roster />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/login" element={<Login />} />
        <Route path="/members" element={<Navigate to="/roster" replace />} />
        <Route path="*" element={<h1 className="odz-title">Not found</h1>} />
      </Route>
    </Routes>
  )
}
