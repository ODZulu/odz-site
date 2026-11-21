import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('./supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, isSupabaseConfigured: true }))

import { createEvent, emptyEventForm, toSaveArgs, updateEvent, type EventForm } from './events'

const form: EventForm = { ...emptyEventForm, title: 'Fake Meeting', event_type: 'Meeting', starts: '2030-01-05T10:00' }

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: 'id-1', error: null })
})

describe('saving an event is one call (MVA-303)', () => {
  it('create sends the audience with the event, in a single save_event call', async () => {
    await createEvent({ ...form, audience: 'command' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('save_event', expect.objectContaining({ p_id: null, p_audience: 'command' }))
  })

  it('update sends the audience with the event, in a single save_event call', async () => {
    await updateEvent('abc', { ...form, audience: 'old_guard' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('save_event', expect.objectContaining({ p_id: 'abc', p_audience: 'old_guard' }))
  })

  it('never calls anything else, so a failure cannot leave an unrestricted event behind', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })
    await expect(createEvent({ ...form, audience: 'command' })).rejects.toThrow('events')
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['save_event'])
  })

  it("the form's empty audience is sent as the explicit 'public'", () => {
    expect(toSaveArgs(null, { ...form, audience: '' }).p_audience).toBe('public')
    expect(toSaveArgs(null, { ...form, audience: 'members' }).p_audience).toBe('members')
  })
})
