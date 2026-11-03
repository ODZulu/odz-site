import { describe, expect, it } from 'vitest'
import {
  agendaMessage,
  emptyItemForm,
  eventMinutes,
  itemsForMinutes,
  moveItem,
  overrunMinutes,
  publishState,
  showUpdatedMark,
  totalMinutes,
  validateItem,
  visibleItems,
  type Viewer,
} from './agenda'

const item = (o: Partial<{ visibility: 'members' | 'command' | 'presenter'; presenter_id: string | null }> = {}) => ({
  visibility: 'members' as const,
  presenter_id: null,
  ...o,
})

describe('minute totals', () => {
  it('adds planned minutes', () => {
    expect(totalMinutes([{ planned_minutes: 10 }, { planned_minutes: 15 }, { planned_minutes: 0 }])).toBe(25)
    expect(totalMinutes([])).toBe(0)
  })
  it('reads the scheduled length from the event', () => {
    expect(eventMinutes('2026-11-03T19:30:00Z', '2026-11-03T21:00:00Z')).toBe(90)
    expect(eventMinutes('2026-11-03T19:30:00Z', null)).toBeNull()
    expect(eventMinutes('2026-11-03T19:30:00Z', '2026-11-03T19:30:00Z')).toBeNull()
  })
  it('warns only when the agenda exceeds the scheduled duration', () => {
    expect(overrunMinutes(100, 90)).toBe(10)
    expect(overrunMinutes(90, 90)).toBe(0)
    expect(overrunMinutes(80, 90)).toBe(0)
    expect(overrunMinutes(500, null)).toBe(0)
  })
})

describe('visibility by level (mirror of the row rules)', () => {
  const items = [
    item({ visibility: 'members' }),
    item({ visibility: 'command' }),
    item({ visibility: 'presenter', presenter_id: 'p1' }),
    item({ visibility: 'presenter', presenter_id: 'p2' }),
  ]
  const member: Viewer = { userId: 'm1', isManager: false, canReadDetails: true }
  const recruit: Viewer = { userId: 'r1', isManager: false, canReadDetails: false }
  const presenter: Viewer = { userId: 'p1', isManager: false, canReadDetails: true }
  const command: Viewer = { userId: 'c1', isManager: true, canReadDetails: true }

  it('shows a draft to Command only', () => {
    expect(visibleItems(items, 'draft', command)).toHaveLength(4)
    expect(visibleItems(items, 'draft', member)).toHaveLength(0)
    expect(visibleItems(items, 'draft', presenter)).toHaveLength(0)
  })
  it('shows a published agenda by level', () => {
    expect(visibleItems(items, 'published', member)).toHaveLength(1)
    expect(visibleItems(items, 'published', presenter)).toHaveLength(2)
    expect(visibleItems(items, 'published', recruit)).toHaveLength(0)
    expect(visibleItems(items, 'published', command)).toHaveLength(4)
    expect(visibleItems(items, 'published', { userId: null, isManager: false, canReadDetails: false })).toHaveLength(0)
  })
})

describe('publish state', () => {
  it('is draft until published', () => {
    expect(publishState(null, [])).toBe('draft')
    expect(publishState({ status: 'draft' }, [{ edited_since_publish: false }])).toBe('draft')
  })
  it('flags edits made after publishing', () => {
    expect(publishState({ status: 'published' }, [{ edited_since_publish: false }])).toBe('published')
    expect(publishState({ status: 'published' }, [{ edited_since_publish: false }, { edited_since_publish: true }])).toBe('pending_update')
  })
  it('marks items updated by the latest republish only', () => {
    expect(showUpdatedMark({ updated_in_publish: 2 }, { publish_count: 2 })).toBe(true)
    expect(showUpdatedMark({ updated_in_publish: 2 }, { publish_count: 3 })).toBe(false)
    expect(showUpdatedMark({ updated_in_publish: null }, { publish_count: 2 })).toBe(false)
    expect(showUpdatedMark({ updated_in_publish: 1 }, { publish_count: 1 })).toBe(false)
  })
})

describe('copy to minutes exclusions', () => {
  const items = [item({ visibility: 'members' }), item({ visibility: 'command' }), item({ visibility: 'presenter', presenter_id: 'p' })]
  it('copies only Members-level items by default', () => {
    expect(itemsForMinutes(items, false)).toHaveLength(1)
  })
  it('copies the rest only when Command includes them', () => {
    expect(itemsForMinutes(items, true)).toHaveLength(3)
  })
})

describe('reordering', () => {
  it('swaps with a neighbour and refuses to leave the list', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toBeNull()
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toBeNull()
  })
})

describe('item validation', () => {
  it('needs a title, sane minutes, and a presenter for presenter-only items', () => {
    expect(validateItem(emptyItemForm).title).toBeDefined()
    expect(validateItem({ ...emptyItemForm, title: 'ok' })).toEqual({})
    expect(validateItem({ ...emptyItemForm, title: 'ok', planned_minutes: '-1' }).planned_minutes).toBeDefined()
    expect(validateItem({ ...emptyItemForm, title: 'ok', planned_minutes: '2.5' }).planned_minutes).toBeDefined()
    expect(validateItem({ ...emptyItemForm, title: 'ok', planned_minutes: '999' }).planned_minutes).toBeDefined()
    expect(validateItem({ ...emptyItemForm, title: 'ok', visibility: 'presenter' }).presenter_id).toBeDefined()
    expect(validateItem({ ...emptyItemForm, title: 'ok', visibility: 'presenter', presenter_id: 'p' })).toEqual({})
    expect(validateItem({ ...emptyItemForm, title: 'ok', notes_md: 'x'.repeat(3001) }).notes_md).toBeDefined()
    expect(validateItem({ ...emptyItemForm, title: 'ok', presenter_notes_md: 'x'.repeat(3001) }).presenter_notes_md).toBeDefined()
  })
  it('maps database codes without echoing input', () => {
    expect(agendaMessage('empty_agenda')).toMatch(/at least one/)
    expect(agendaMessage('nothing else')).toBe('That did not work. Try again.')
  })
})
