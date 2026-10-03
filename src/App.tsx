import { NavLink, Route, Routes } from 'react-router'
import Landing from './pages/Landing'
import Calendar from './pages/Calendar'
import Login from './pages/Login'
import Members from './pages/Members'

const links = [
  { to: '/', label: 'Home' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/login', label: 'Login' },
  { to: '/members', label: 'Members' },
]

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <nav className="flex gap-4 border-b border-neutral-800 px-4 py-3 text-sm">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end
            className={({ isActive }) => (isActive ? 'font-bold text-lime-400' : 'text-neutral-400')}
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
      <main className="p-4">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/login" element={<Login />} />
          <Route path="/members" element={<Members />} />
          <Route path="*" element={<h1 className="text-xl">Not found</h1>} />
        </Routes>
      </main>
    </div>
  )
}
