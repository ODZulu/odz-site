/**
 * Meeting agendas (MVA-245). The database enforces who sees what and what a publish does; these
 * helpers do the arithmetic and mirror the rules so the screens can show state, and are tested
 * against the same cases as the SQL.
 */

export type ItemKind = 'inform' | 'discuss' | 'vote'
export type Visibility = 'members' | 'command' | 'presenter'
export type AgendaStatus = 'draft' | 'published'

export type AgendaItem = {
  id: string
  agenda_id: string
  position: number
  title: string
  planned_minutes: number
  kind: ItemKind
  presenter_id: string | null
  visibility: Visibility
  notes_md: string | null
  vote_wording: string | null
  outcome_md: string | null
  edited_since_publish: boolean
  updated_in_publish: number | null
}

export type Agenda = { id: string; event_id: string; status: AgendaStatus; publish_count: number; published_at: string | null }

export const NOTES_MAX = 3000
export const WORDING_MAX = 1500
export const OUTCOME_MAX = 2000
export const MAX_ITEM_MINUTES = 480

export const KIND_LABEL: Record<ItemKind, string> = { inform: 'For information', discuss: 'Discussion', vote: 'Vote' }
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  members: 'Members',
  command: 'Command only',
  presenter: 'Presenter only',
}

/** Total planned minutes. When `viewer` is given, only the items that viewer can see are counted. */
export const totalMinutes = (items: readonly Pick<AgendaItem, 'planned_minutes'>[]): number =>
  items.reduce((sum, i) => sum + i.planned_minutes, 0)

/** Scheduled length of the meeting in minutes, or null when the event has no end time. */
export function eventMinutes(startsAt: string, endsAt: string | null): number | null {
  if (!endsAt) return null
  const m = Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000)
  return m > 0 ? m : null
}

/** Minutes by which the agenda overruns the meeting; 0 when it fits or the event has no end time. */
export function overrunMinutes(total: number, scheduled: number | null): number {
  return scheduled !== null && total > scheduled ? total - scheduled : 0
}

export type Viewer = { userId: string | null; isManager: boolean; canReadDetails: boolean }

/**
 * Mirror of the row rules: managers (Command, Admin, write_events) see every level, even in a
 * draft; everyone else sees nothing until the agenda is published, then Members-level items (if
 * they can read event details) and Presenter-level items they present.
 */
export function visibleItems<T extends Pick<AgendaItem, 'visibility' | 'presenter_id'>>(
  items: readonly T[],
  status: AgendaStatus,
  viewer: Viewer,
): T[] {
  if (viewer.isManager) return [...items]
  if (status !== 'published') return []
  return items.filter(
    (i) =>
      (i.visibility === 'members' && viewer.canReadDetails) ||
      (i.visibility === 'presenter' && viewer.userId !== null && i.presenter_id === viewer.userId),
  )
}

export type PublishState = 'draft' | 'published' | 'pending_update'

/** A published agenda with edits not yet republished is `pending_update`. */
export function publishState(agenda: Pick<Agenda, 'status'> | null, items: readonly Pick<AgendaItem, 'edited_since_publish'>[]): PublishState {
  if (!agenda || agenda.status === 'draft') return 'draft'
  return items.some((i) => i.edited_since_publish) ? 'pending_update' : 'published'
}

/** Whether the "updated" mark shows on an item: it changed in the latest publish, and that was a republish. */
export const showUpdatedMark = (i: Pick<AgendaItem, 'updated_in_publish'>, agenda: Pick<Agenda, 'publish_count'>): boolean =>
  agenda.publish_count > 1 && i.updated_in_publish === agenda.publish_count

/**
 * Items that "Create minutes from agenda" copies: Members-level always; Command and Presenter
 * level only when Command explicitly includes them. (Presenter notes are a separate choice.)
 */
export function itemsForMinutes<T extends Pick<AgendaItem, 'visibility'>>(items: readonly T[], includeNonMembers: boolean): T[] {
  return items.filter((i) => i.visibility === 'members' || includeNonMembers)
}

/** Moves item `index` by `delta` (-1 up, +1 down) and returns the new id order, or null if it cannot move. */
export function moveItem(ids: readonly string[], index: number, delta: -1 | 1): string[] | null {
  const to = index + delta
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return null
  const next = [...ids]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

export type ItemForm = {
  title: string
  planned_minutes: string
  kind: ItemKind
  presenter_id: string
  visibility: Visibility
  notes_md: string
  presenter_notes_md: string
  vote_wording: string
  outcome_md: string
}

export const emptyItemForm: ItemForm = {
  title: '',
  planned_minutes: '5',
  kind: 'discuss',
  presenter_id: '',
  visibility: 'members',
  notes_md: '',
  presenter_notes_md: '',
  vote_wording: '',
  outcome_md: '',
}

export type ItemErrors = Partial<Record<keyof ItemForm, string>>

export function validateItem(f: ItemForm): ItemErrors {
  const e: ItemErrors = {}
  if (f.title.trim() === '') e.title = 'Title is required.'
  else if (f.title.trim().length > 160) e.title = 'Title is too long.'
  const m = Number(f.planned_minutes)
  if (!Number.isInteger(m) || m < 0 || m > MAX_ITEM_MINUTES) e.planned_minutes = `Minutes must be 0 to ${MAX_ITEM_MINUTES}.`
  if (f.visibility === 'presenter' && f.presenter_id === '') e.presenter_id = 'A presenter-only item needs a presenter.'
  if (f.notes_md.length > NOTES_MAX) e.notes_md = `At most ${NOTES_MAX} characters.`
  if (f.presenter_notes_md.length > NOTES_MAX) e.presenter_notes_md = `At most ${NOTES_MAX} characters.`
  if (f.vote_wording.length > WORDING_MAX) e.vote_wording = `At most ${WORDING_MAX} characters.`
  if (f.outcome_md.length > OUTCOME_MAX) e.outcome_md = `At most ${OUTCOME_MAX} characters.`
  return e
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  not_found: 'That agenda is not available.',
  not_a_meeting: 'Only a Meeting can have an agenda.',
  empty_agenda: 'Add at least one item before publishing.',
  nothing_to_publish: 'Nothing has changed since the last publish.',
  event_cancelled: 'This meeting is cancelled.',
  bad_order: 'That order is not valid. Reload and try again.',
}

/** Maps the database's fixed error codes to words. Never echoes anything the user typed. */
export function agendaMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Try again.'
}
