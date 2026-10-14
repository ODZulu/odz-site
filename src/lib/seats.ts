/**
 * Seat caps (MVA-234): Old Guard (Command counted inside it) and Command. The database enforces
 * them; these helpers format the counters and explain a refusal before asking.
 */

export type SeatCounts = {
  old_guard_count: number
  old_guard_max: number
  command_count: number
  command_max: number
}

export const CAP_MIN = 1
export const CAP_MAX = 99

/** "Old Guard 11/12, Command 3/3" */
export function seatLine(c: SeatCounts): string {
  return `Old Guard ${c.old_guard_count}/${c.old_guard_max}, Command ${c.command_count}/${c.command_max}`
}

/** Open seats, never negative. */
export function vacancies(c: SeatCounts): { oldGuard: number; command: number } {
  return {
    oldGuard: Math.max(0, c.old_guard_max - c.old_guard_count),
    command: Math.max(0, c.command_max - c.command_count),
  }
}

export function isOverCap(c: SeatCounts): boolean {
  return c.old_guard_count > c.old_guard_max || c.command_count > c.command_max
}

/** The vacancy line for the roster page. */
export function vacancyText(c: SeatCounts): string {
  const v = vacancies(c)
  const open = `Vacant: Old Guard ${v.oldGuard}, Command ${v.command}.`
  return isOverCap(c) ? `${open} Over the cap: promotions are blocked until the count is back under it.` : open
}

/** The database's own "Old Guard is full: 12/12" text, or null for any other error. */
export function fullMessage(message: string | undefined): string | null {
  const m = /(Old Guard|Command) is full: \d+\/\d+/.exec(message ?? '')
  return m ? m[0] : null
}

export function validateCaps(oldGuard: number, command: number): string | null {
  if (!Number.isInteger(oldGuard) || !Number.isInteger(command)) return 'Enter whole numbers.'
  if (oldGuard < CAP_MIN || oldGuard > CAP_MAX || command < CAP_MIN || command > CAP_MAX) {
    return `Each cap must be ${CAP_MIN} to ${CAP_MAX}.`
  }
  return command > oldGuard ? 'The Command cap cannot be higher than the Old Guard cap (Command is part of Old Guard).' : null
}
