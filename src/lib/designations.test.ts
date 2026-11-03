import { describe, expect, it } from 'vitest'
import { assignableTo, designationNamesFor, filterByDesignation, isVacant, type Designation, type MemberDesignation } from './designations'

const catalog: Designation[] = [
  { id: 'd1', name: 'Treasurer', description: '', capability_key: 'manage_treasury', office_seat: true, max_holders: 1 },
  { id: 'd2', name: 'Quartermaster', description: '', capability_key: 'manage_inventory', office_seat: true, max_holders: 1 },
  { id: 'd3', name: 'Shop Manager', description: '', capability_key: 'manage_shop', office_seat: false, max_holders: 1 },
]
const assignments: MemberDesignation[] = [
  { profile_id: 'p1', designation_id: 'd1' },
  { profile_id: 'p1', designation_id: 'd2' },
  { profile_id: 'p2', designation_id: 'd3' },
]

describe('designationNamesFor', () => {
  it('lists the names a profile holds', () => {
    expect(designationNamesFor('p1', assignments, catalog)).toEqual(['Treasurer', 'Quartermaster'])
    expect(designationNamesFor('p2', assignments, catalog)).toEqual(['Shop Manager'])
  })
  it('is empty for a profile with no designations', () => {
    expect(designationNamesFor('p3', assignments, catalog)).toEqual([])
  })
})

describe('filterByDesignation', () => {
  const members = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
  it('keeps only holders of the given designation', () => {
    expect(filterByDesignation(members, assignments, 'd1')).toEqual([{ id: 'p1' }])
    expect(filterByDesignation(members, assignments, 'd3')).toEqual([{ id: 'p2' }])
  })
  it('keeps everyone when no designation is selected', () => {
    expect(filterByDesignation(members, assignments, null)).toEqual(members)
    expect(filterByDesignation(members, assignments, '')).toEqual(members)
  })
  it('is empty when nobody holds the designation', () => {
    expect(filterByDesignation(members, assignments, 'd-nobody')).toEqual([])
  })
})

describe('isVacant', () => {
  it('is vacant only at zero holders', () => {
    expect(isVacant(0)).toBe(true)
    expect(isVacant(1)).toBe(false)
  })
})

describe('assignableTo', () => {
  it('excludes designations already held', () => {
    expect(assignableTo('p1', assignments, catalog).map((d) => d.name)).toEqual(['Shop Manager'])
  })
  it('offers the full catalog to a profile with no designations', () => {
    expect(assignableTo('p3', assignments, catalog)).toEqual(catalog)
  })
})
