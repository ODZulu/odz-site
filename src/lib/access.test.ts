import { describe, expect, it } from 'vitest'
import { homeFor, redirectFor, redirectIfSignedIn, type AccessState, type AccountStatus } from './access'

const state = (status: AccountStatus, setup_complete: boolean): AccessState => ({
  loading: false,
  signedIn: true,
  profile: { status, setup_complete },
})
const anon: AccessState = { loading: false, signedIn: false, profile: null }
const loading: AccessState = { loading: true, signedIn: false, profile: null }

describe('homeFor', () => {
  it('waits while loading', () => expect(homeFor(loading)).toBeNull())
  it('sends signed-out visitors to login', () => expect(homeFor(anon)).toBe('/login'))
  it('sends a signed-in account with no profile to login', () =>
    expect(homeFor({ loading: false, signedIn: true, profile: null })).toBe('/login'))
  it('denies suspended accounts, even before setup', () => {
    expect(homeFor(state('suspended', false))).toBe('/denied')
    expect(homeFor(state('suspended', true))).toBe('/denied')
  })
  it('denies removed accounts, even before setup', () => {
    expect(homeFor(state('removed', false))).toBe('/denied')
    expect(homeFor(state('removed', true))).toBe('/denied')
  })
  it('makes setup come first, pending or not', () => {
    expect(homeFor(state('pending', false))).toBe('/setup')
    expect(homeFor(state('approved', false))).toBe('/setup')
  })
  it('holds pending accounts after setup', () => expect(homeFor(state('pending', true))).toBe('/pending'))
  it('lets approved accounts into the app', () => expect(homeFor(state('approved', true))).toBe('/hq'))
  it('sends retired accounts to their limited home (MVA-238), after setup', () => {
    expect(homeFor(state('retired', true))).toBe('/retired')
    expect(homeFor(state('retired', false))).toBe('/setup')
  })
})

describe('redirectFor', () => {
  it('does not redirect while loading', () => expect(redirectFor(loading, 'app')).toBeNull())
  it('keeps unauthenticated visitors out of the app', () => expect(redirectFor(anon, 'app')).toBe('/login'))
  it('keeps pending accounts out of the app', () => expect(redirectFor(state('pending', true), 'app')).toBe('/pending'))
  it('keeps accounts with incomplete setup out of the app', () =>
    expect(redirectFor(state('approved', false), 'app')).toBe('/setup'))
  it('keeps suspended accounts out of the app', () => expect(redirectFor(state('suspended', true), 'app')).toBe('/denied'))
  it('keeps removed accounts out of the app', () => expect(redirectFor(state('removed', true), 'app')).toBe('/denied'))
  it('renders the page an account belongs on', () => {
    expect(redirectFor(state('approved', true), 'app')).toBeNull()
    expect(redirectFor(state('pending', false), 'setup')).toBeNull()
    expect(redirectFor(state('pending', true), 'pending')).toBeNull()
    expect(redirectFor(state('suspended', true), 'denied')).toBeNull()
  })
  it('does not let a finished account re-enter setup', () =>
    expect(redirectFor(state('pending', true), 'setup')).toBe('/pending'))
  it('does not show the pending screen to approved accounts', () =>
    expect(redirectFor(state('approved', true), 'pending')).toBe('/hq'))
  it('keeps retired accounts out of the full app and shows them their own home (MVA-238)', () => {
    expect(redirectFor(state('retired', true), 'app')).toBe('/retired')
    expect(redirectFor(state('retired', true), 'retired')).toBeNull()
    expect(redirectFor(state('approved', true), 'retired')).toBe('/hq')
    expect(redirectFor(state('pending', true), 'retired')).toBe('/pending')
  })
  it('opens shared pages (Traffic, notifications) to approved and retired accounts only', () => {
    expect(redirectFor(state('approved', true), 'shared')).toBeNull()
    expect(redirectFor(state('retired', true), 'shared')).toBeNull()
    expect(redirectFor(state('pending', true), 'shared')).toBe('/pending')
    expect(redirectFor(state('suspended', true), 'shared')).toBe('/denied')
    expect(redirectFor(state('removed', true), 'shared')).toBe('/denied')
    expect(redirectFor(anon, 'shared')).toBe('/login')
  })
})

describe('redirectIfSignedIn', () => {
  it('leaves signed-out visitors on public pages', () => expect(redirectIfSignedIn(anon)).toBeNull())
  it('moves signed-in accounts on', () => expect(redirectIfSignedIn(state('approved', true))).toBe('/hq'))
  it('moves retired accounts to their own home', () => expect(redirectIfSignedIn(state('retired', true))).toBe('/retired'))
})
