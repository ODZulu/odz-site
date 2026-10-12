import { describe, expect, it } from 'vitest'
import { BIO_MAX, ROLE_MAX, counter, filterRoster, findByCallsign, sortRoster, validateOwnProfile } from './roster'

const m = (callsign: string, rank: number | null) => ({ callsign, tier: rank === null ? null : { name: `T${rank}`, rank } })

describe('sortRoster', () => {
  it('orders by tier rank, then callsign ignoring case', () => {
    const sorted = sortRoster([m('delta', 3), m('Bravo', 1), m('alpha', 3), m('Charlie', 1)])
    expect(sorted.map((x) => x.callsign)).toEqual(['Bravo', 'Charlie', 'alpha', 'delta'])
  })
  it('puts members with no tier last', () => {
    expect(sortRoster([m('a', null), m('b', 6), m('c', 2)]).map((x) => x.callsign)).toEqual(['c', 'b', 'a'])
  })
  it('does not mutate its input', () => {
    const input = [m('b', 1), m('a', 1)]
    sortRoster(input)
    expect(input[0].callsign).toBe('b')
  })
})

describe('filterRoster', () => {
  const list = [m('Fox-Trot', 1), m('Echo', 1), m('foxhound', 2)]
  it('matches callsigns case-insensitively', () => {
    expect(filterRoster(list, 'FOX').map((x) => x.callsign)).toEqual(['Fox-Trot', 'foxhound'])
  })
  it('keeps everyone for an empty query', () => expect(filterRoster(list, '  ')).toHaveLength(3))
  it('finds nobody for a miss', () => expect(filterRoster(list, 'zzz')).toEqual([]))
})

describe('findByCallsign', () => {
  it('matches exactly, ignoring case', () => {
    const list = [m('Fox-Trot', 1), m('Fox', 1)]
    expect(findByCallsign(list, 'fox')?.callsign).toBe('Fox')
    expect(findByCallsign(list, 'nope')).toBeUndefined()
  })
})

describe('own profile limits', () => {
  it('accepts the maximum lengths', () => {
    expect(validateOwnProfile({ display_name: 'x', role_note: 'r'.repeat(ROLE_MAX), bio: 'b'.repeat(BIO_MAX) })).toEqual({})
  })
  it('rejects one over', () => {
    const e = validateOwnProfile({ display_name: 'x', role_note: 'r'.repeat(ROLE_MAX + 1), bio: 'b'.repeat(BIO_MAX + 1) })
    expect(Object.keys(e).sort()).toEqual(['bio', 'role_note'])
  })
  it('shows a live counter', () => expect(counter('abc', 280)).toBe('3/280'))
})
