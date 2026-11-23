/**
 * Event prep cadence templates (MVA-229). The database owns the rules (event_cadence_plan and
 * event_cadence_apply share one plan); these helpers mirror the date maths for tests and previews,
 * validate the template form, and word the plan's actions for people.
 */
import type { Audience } from './recurrence'
import { localToUtc, addDays } from './recurrence'

export type CadenceStep = {
  id: string | null
  title: string
  offset_days: number
  local_time: string
  duration_minutes: number
  audience: Audience
  topics: string | null
}

export type CadenceTemplate = {
  id: string
  name: string
  event_type: string | null
  auto_apply: boolean
  timezone: string
  status: 'active' | 'retired'
  steps: CadenceStep[]
}

export type PlanAction = 'create' | 'skip_past' | 'update' | 'unchanged' | 'leave_edited' | 'past'

export type PlanRow = {
  step_id: string
  step_position: number
  step_title: string
  action: PlanAction
  meeting_id: string | null
  current_starts_at: string | null
  new_starts_at: string
}

export const ACTION_LABEL: Record<PlanAction, string> = {
  create: 'Will be created',
  skip_past: 'Skipped: that date has already passed',
  update: 'Will be updated to match the template',
  unchanged: 'Already matches',
  leave_edited: 'Left alone: it was edited by hand',
  past: 'Already happened',
}

/** The local calendar date of an instant in a timezone ("YYYY-MM-DD"). */
export function localDate(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  return parts
}

/** When a step's meeting starts: the event's local date minus the offset, at the step's local time. Mirrors cadence_start(). */
export function stepStart(eventStartsAt: string, tz: string, offsetDays: number, localTime: string): string {
  return localToUtc(addDays(localDate(eventStartsAt, tz), -offsetDays), localTime.slice(0, 5), tz)
}

/** Steps whose meeting would already be in the past at `now`: they are skipped, and the user is told which. */
export function skippedSteps(steps: readonly Pick<CadenceStep, 'title' | 'offset_days' | 'local_time'>[], eventStartsAt: string, tz: string, now: Date): string[] {
  return steps.filter((s) => new Date(stepStart(eventStartsAt, tz, s.offset_days, s.local_time)).getTime() <= now.getTime()).map((s) => s.title)
}

export type PlanSummary = { create: number; update: number; skipped: string[]; edited: string[] }

export function summarisePlan(rows: readonly Pick<PlanRow, 'action' | 'step_title'>[]): PlanSummary {
  return {
    create: rows.filter((r) => r.action === 'create').length,
    update: rows.filter((r) => r.action === 'update').length,
    skipped: rows.filter((r) => r.action === 'skip_past').map((r) => r.step_title),
    edited: rows.filter((r) => r.action === 'leave_edited').map((r) => r.step_title),
  }
}

export type StepForm = { id: string | null; title: string; offset_days: string; local_time: string; duration_minutes: string; audience: Audience; topics: string }
export type TemplateForm = { name: string; event_type: string; auto_apply: boolean; steps: StepForm[] }

export const emptyStep = (): StepForm => ({ id: null, title: '', offset_days: '14', local_time: '19:00', duration_minutes: '60', audience: 'command', topics: '' })
export const emptyTemplateForm = (): TemplateForm => ({ name: '', event_type: '', auto_apply: false, steps: [emptyStep()] })

export type TemplateErrors = { name?: string; auto_apply?: string; steps?: string; step?: Record<number, string> }

export function validateTemplate(f: TemplateForm): TemplateErrors {
  const e: TemplateErrors = {}
  if (f.name.trim() === '') e.name = 'Give the template a name.'
  else if (f.name.trim().length > 80) e.name = 'Name is too long (80 characters).'
  if (f.auto_apply && f.event_type === '') e.auto_apply = 'Choose an event type for an automatic template.'
  if (f.steps.length < 1) e.steps = 'Add at least one step.'
  if (f.steps.length > 30) e.steps = 'At most 30 steps.'
  const bad: Record<number, string> = {}
  f.steps.forEach((s, i) => {
    const off = Number(s.offset_days)
    const dur = Number(s.duration_minutes)
    if (s.title.trim() === '' || s.title.trim().length > 80) bad[i] = 'Each step needs a title (up to 80 characters).'
    else if (!Number.isInteger(off) || off < 0 || off > 730 || s.offset_days.trim() === '') bad[i] = 'Days before must be a whole number from 0 to 730.'
    else if (!/^\d{2}:\d{2}$/.test(s.local_time)) bad[i] = 'Enter a time of day.'
    else if (!Number.isInteger(dur) || dur < 15 || dur > 1440) bad[i] = 'Duration is 15 to 1440 minutes.'
    else if (s.topics.length > 2000) bad[i] = 'Topics are too long (2000 characters).'
  })
  if (Object.keys(bad).length > 0) e.step = bad
  return e
}

export const hasTemplateErrors = (e: TemplateErrors): boolean => Object.keys(e).length > 0

/** The p_steps JSON for event_cadence_template_save(). Call only after validateTemplate() is clean. */
export function toStepsJson(steps: readonly StepForm[]) {
  return steps.map((s) => ({
    id: s.id,
    title: s.title.trim(),
    offset_days: Number(s.offset_days),
    local_time: s.local_time,
    duration_minutes: Number(s.duration_minutes),
    audience: s.audience,
    topics: s.topics.trim() || null,
  }))
}

export function toTemplateForm(t: CadenceTemplate): TemplateForm {
  return {
    name: t.name,
    event_type: t.event_type ?? '',
    auto_apply: t.auto_apply,
    steps: t.steps.map((s) => ({
      id: s.id,
      title: s.title,
      offset_days: String(s.offset_days),
      local_time: s.local_time.slice(0, 5),
      duration_minutes: String(s.duration_minutes),
      audience: s.audience,
      topics: s.topics ?? '',
    })),
  }
}

const messages: Record<string, string> = {
  'not allowed': 'You are not allowed to do that.',
  invalid_name: 'Give the template a name (up to 80 characters).',
  invalid_event_type: 'Choose a valid event type.',
  auto_needs_type: 'An automatic template needs an event type.',
  invalid_timezone: 'That timezone is not recognised.',
  invalid_steps: 'A template needs 1 to 30 steps.',
  invalid_step: 'Check each step: title, days before, time, duration and who it is for.',
  not_scheduled: 'Only a scheduled event can take a prep cadence.',
  template_retired: 'That template is retired.',
  'not found': 'That template or event is not available.',
}

export function cadenceMessage(code: string | undefined | null): string {
  return (code && messages[code]) || 'That did not work. Check the form and try again.'
}

/** Meetings generated for an event, soonest first: the prep timeline. */
export function prepTimeline<T extends { id: string; source_event_id?: string | null; starts_at: string }>(events: readonly T[], eventId: string): T[] {
  return events.filter((e) => e.source_event_id === eventId).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
}
