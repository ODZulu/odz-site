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
})

describe('redirectIfSignedIn', () => {
  it('leaves signed-out visitors on public pages', () => expect(redirectIfSignedIn(anon)).toBeNull())
  it('moves signed-in accounts on', () => expect(redirectIfSignedIn(state('approved', true))).toBe('/hq'))
})
