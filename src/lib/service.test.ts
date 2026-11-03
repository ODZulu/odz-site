import { describe, expect, it } from 'vitest'
import { missionCount, sortBySeniority, validateEntry, yearsOfService, type ServiceEntry } from './service'

describe('yearsOfService', () => {
  it('is null with no DOE', () => {
    expect(yearsOfService(null)).toBeNull()
    expect(yearsOfService('')).toBeNull()
    expect(yearsOfService('not-a-date')).toBeNull()
  })

  it('counts whole years, not yet past the anniversary this year', () => {
    expect(yearsOfService('2014-11-10', new Date('2026-11-02T00:00:00Z'))).toBe(11)
  })

  it('counts the extra year once the anniversary has passed', () => {
    expect(yearsOfService('2014-10-01', new Date('2026-11-02T00:00:00Z'))).toBe(12)
  })

  it('is exactly 0 on the day itself, never negative', () => {
    expect(yearsOfService('2026-11-02', new Date('2026-11-02T00:00:00Z'))).toBe(0)
    expect(yearsOfService('2026-12-01', new Date('2026-11-02T00:00:00Z'))).toBe(0)
  })
})

describe('missionCount', () => {
  it('counts every entry, manual and app alike', () => {
    const entries = [
      { source: 'manual' } as ServiceEntry,
      { source: 'app' } as ServiceEntry,
    ]
    expect(missionCount(entries)).toBe(2)
    expect(missionCount([])).toBe(0)
  })
})

describe('validateEntry', () => {
  const base = { event_date: '2015-06-01', title: 'Road to Rostov', location: '', role: '', notes: '' }

  it('accepts a minimal valid entry', () => {
    expect(validateEntry(base)).toEqual({})
  })

  it('requires a valid date', () => {
    expect(validateEntry({ ...base, event_date: '' }).event_date).toBeTruthy()
    expect(validateEntry({ ...base, event_date: '06/01/2015' }).event_date).toBeTruthy()
  })

  it('requires a title, at most 80 characters', () => {
    expect(validateEntry({ ...base, title: '' }).title).toBeTruthy()
    expect(validateEntry({ ...base, title: '   ' }).title).toBeTruthy()
    expect(validateEntry({ ...base, title: 'x'.repeat(80) }).title).toBeUndefined()
    expect(validateEntry({ ...base, title: 'x'.repeat(81) }).title).toBeTruthy()
  })

  it('caps location, role and notes', () => {
    expect(validateEntry({ ...base, location: 'x'.repeat(81) }).location).toBeTruthy()
    expect(validateEntry({ ...base, role: 'x'.repeat(61) }).role).toBeTruthy()
    expect(validateEntry({ ...base, notes: 'x'.repeat(501) }).notes).toBeTruthy()
  })
})

describe('sortBySeniority', () => {
  it('earliest DOE first', () => {
    const rows = [{ doe: '2018-01-01' }, { doe: '2014-01-01' }, { doe: '2020-01-01' }]
    expect(sortBySeniority(rows).map((r) => r.doe)).toEqual(['2014-01-01', '2018-01-01', '2020-01-01'])
  })

  it('sorts a missing DOE last', () => {
    const rows = [{ doe: null }, { doe: '2014-01-01' }]
    expect(sortBySeniority(rows).map((r) => r.doe)).toEqual(['2014-01-01', null])
  })
})
