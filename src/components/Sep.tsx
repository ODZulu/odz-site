/** Text separator between values (a middot). Decoration, so it is hidden from assistive tech and set in the quiet grey. */
export function Sep() {
  return (
    <span className="odz-sep" aria-hidden="true">
      {' · '}
    </span>
  )
}
