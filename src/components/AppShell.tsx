import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { AppNav } from './AppNav'
import { TopBar } from './TopBar'

/** The signed-in frame. Used as a layout route, or around `children` for pages shared with the public. */
export function AppShell({ children }: { children?: ReactNode }) {
  return (
    <div className="odz">
      <TopBar />
      <AppNav />
      <main className="odz-page">{children ?? <Outlet />}</main>
    </div>
  )
}
