import { describe, expect, it } from 'vitest'
import { createSaveGate } from './saveGate'

/** Mirrors NotificationSettings: a save reports "Saved." only while its ticket is current. */
function screen() {
  const gate = createSaveGate()
  let message: string | null = null
  const save = (finish: Promise<void>) => {
    const ticket = gate.begin()
    return finish.then(() => {
      if (gate.isCurrent(ticket)) message = 'Saved.'
    })
  }
  const refuse = () => {
    gate.supersede()
    message = 'Keep at least one reminder time.'
  }
  return { save, refuse, message: () => message }
}

const later = () => {
  let done!: () => void
  const p = new Promise<void>((resolve) => (done = resolve))
  return { p, done }
}

describe('createSaveGate', () => {
  it('reproduces the MVA-247 race when nothing guards the late save (why the gate exists)', async () => {
    let message: string | null = null
    const slow = later()
    const save = slow.p.then(() => {
      message = 'Saved.' // the old behaviour: every save reports back
    })
    message = 'Keep at least one reminder time.' // the refusal arrives first
    slow.done()
    await save
    expect(message).toBe('Saved.') // the refusal was overwritten
  })

  it('a stale save cannot replace the refusal message (the MVA-247 race)', async () => {
    const s = screen()
    const first = later()
    const second = later()
    const a = s.save(first.p) // uncheck 24 hours
    const b = s.save(second.p) // uncheck 2 hours
    s.refuse() // uncheck the last one: refused at once
    expect(s.message()).toBe('Keep at least one reminder time.')
    first.done()
    second.done()
    await Promise.all([a, b])
    expect(s.message()).toBe('Keep at least one reminder time.')
  })

  it('only the newest of several overlapping saves reports Saved, whatever order they finish', async () => {
    const s = screen()
    const first = later()
    const second = later()
    const a = s.save(first.p)
    const b = s.save(second.p)
    second.done()
    await b
    expect(s.message()).toBe('Saved.')
    first.done() // the older one finishing last changes nothing
    await a
    expect(s.message()).toBe('Saved.')
  })

  it('a lone save still reports Saved', async () => {
    const s = screen()
    const only = later()
    const a = s.save(only.p)
    only.done()
    await a
    expect(s.message()).toBe('Saved.')
  })

  it('a refusal after a finished save is not stale: its ticket is only for earlier saves', () => {
    const gate = createSaveGate()
    const t = gate.begin()
    expect(gate.isCurrent(t)).toBe(true)
    gate.supersede()
    expect(gate.isCurrent(t)).toBe(false)
    expect(gate.isCurrent(gate.begin())).toBe(true)
  })
})
