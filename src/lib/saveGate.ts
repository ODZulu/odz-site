/**
 * Sequencing for a screen that saves on every click (MVA-247). Each save takes a ticket; any later
 * action (another save, or a refusal) makes every earlier ticket stale. A stale save may finish, but
 * it must not touch what the screen shows: no late "Saved." over a newer message, and no old reload
 * overwriting newer choices.
 */
export type SaveGate = {
  /** A new save starts: returns its ticket and makes earlier tickets stale. */
  begin: () => number
  /** Something other than a save changed what is shown (a refusal): makes every earlier ticket stale. */
  supersede: () => void
  /** True only if nothing has happened since this ticket was taken. */
  isCurrent: (ticket: number) => boolean
}

export function createSaveGate(): SaveGate {
  let latest = 0
  return {
    begin: () => ++latest,
    supersede: () => {
      latest += 1
    },
    isCurrent: (ticket) => ticket === latest,
  }
}
