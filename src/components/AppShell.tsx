import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery'
import { AppNav } from './AppNav'
import { SideBrand, UserCard } from './SideBar'
import { TopBar } from './TopBar'

/**
 * The signed-in frame (MVA-297 PR B). Desktop: a left sidebar (brand, nav, user card) beside the
 * top bar and page. At 760px and below the sidebar goes away: the nav becomes the bottom tab bar
 * and the top bar carries the brand, callsign and sign out. Each piece is rendered once, so
 * nothing is duplicated in the page for assistive tech or tests. Used as a layout route, or
 * around `children` for pages shared with the public.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const mobile = useMediaQuery(MOBILE_QUERY)
  return (
    <div className="odz odz-shell">
      <aside className="odz-side">
        {!mobile && <SideBrand />}
        <AppNav />
        {!mobile && <UserCard />}
      </aside>
      <div className="odz-shell__main">
        <TopBar mobile={mobile} />
        <main className="odz-page">{children ?? <Outlet />}</main>
      </div>
    </div>
  )
}
