import { describe, expect, it } from 'vitest'
import { crossesSupportLine, defaultInviteTier, supportMoveBlock, validateTierNote, type TierFlags } from './tiers'

const t = (name: string, role_based = false, support_barred = false): TierFlags => ({ id: name, name, role_based, support_barred })
const member = t('Member')
const support = t('Support', true)
const og = t('Old Guard', false, true)

describe('crossesSupportLine', () => {
  it('is true only when one side is role-based', () => {
    expect(crossesSupportLine(member, support)).toBe(true)
    expect(crossesSupportLine(support, member)).toBe(true)
    expect(crossesSupportLine(member, og)).toBe(false)
    expect(crossesSupportLine(support, support)).toBe(false)
    expect(crossesSupportLine(undefined, support)).toBe(false)
  })
})

describe('supportMoveBlock', () => {
  it('allows player <-> Support and blocks Command/Old Guard on either side', () => {
    expect(supportMoveBlock(member, support)).toBeNull()
    expect(supportMoveBlock(support, member)).toBeNull()
    expect(supportMoveBlock(og, support)).toMatch(/Old Guard/)
    expect(supportMoveBlock(support, og)).toMatch(/Old Guard/)
  })
  it('has nothing to say about ordinary moves', () => {
    expect(supportMoveBlock(member, og)).toBeNull()
  })
})

describe('validateTierNote', () => {
  it('needs 3 to 300 characters after trimming', () => {
    expect(validateTierNote('  ab ')).not.toBeNull()
    expect(validateTierNote('now plays')).toBeNull()
    expect(validateTierNote('x'.repeat(301))).not.toBeNull()
  })
})

describe('defaultInviteTier', () => {
  it('is the least senior invitable player tier, never a role-based one', () => {
    const tiers = [
      { id: 'a', rank: 5, invitable: true, role_based: false },
      { id: 'b', rank: 4, invitable: true, role_based: false },
      { id: 'c', rank: 7, invitable: true, role_based: true },
      { id: 'd', rank: 6, invitable: false, role_based: false },
    ]
    expect(defaultInviteTier(tiers)).toBe('a')
    expect(defaultInviteTier([])).toBe('')
  })
})
