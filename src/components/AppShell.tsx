import { Outlet } from 'react-router'
import { AppNav } from './AppNav'
import { TopBar } from './TopBar'

export function AppShell() {
  return (
    <div className="odz">
      <TopBar />
      <AppNav />
      <main className="odz-page">
        <Outlet />
      </main>
    </div>
  )
}
