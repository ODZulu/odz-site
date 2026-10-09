/**
 * Tier marks are the designer's proposal (Field Standard handoff), PENDING DAX SIGN-OFF
 * (Playbook D8: revisit once a rank structure exists). Keep every mark in this one file.
 * Do not bake them into data, DB values or any export. Command has no proposed mark, so it
 * renders as a name only until Dax decides.
 */
const marks: Record<string, string | undefined> = {
  'Old Guard': '<path d="M2 1.5 L13 6.5 L24 1.5"/><path d="M2 7.5 L13 12.5 L24 7.5"/>',
  Member: '<path d="M2 4 L13 10 L24 4"/>',
  Prospect: '<rect x="8" y="2" width="10" height="10"/>',
  Recruit: '<circle cx="13" cy="7" r="2.5"/>',
}

export function TierMark({ tier }: { tier: string }) {
  const mark = marks[tier]
  return (
    <span className="odz-tier">
      {mark && <svg viewBox="0 0 26 14" aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} />}
      {tier}
    </span>
  )
}
