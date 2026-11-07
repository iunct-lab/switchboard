/** The title Home sends (#491): none when the field is empty or holds only the inserted prefix, so the daemon names the task. */
export function titleToSend(title: string, briefTitle?: string): string | undefined {
  const t = title.trim();
  return !t || (briefTitle !== undefined && t === briefTitle.trim()) ? undefined : t;
}

/** What the heading edit saves (#491): null (nothing is sent) for an empty or unchanged title. */
export function titleToSave(value: string, current: string): string | null {
  const next = value.trim();
  return !next || next === current ? null : next;
}

/**
 * A Task's title as the left list shows it (#4060): a stage Task's `#N <工程>: PBI: <題>` without the `PBI: ` (or
 * `要望: `) the stage already implies, so its two lines reach the PBI's own words. Any other title is as it is.
 */
export function listTitle(title: string): string {
  return title.replace(/^(#\d+ [^:：]{1,12}[:：] )(?:PBI|要望)[:：] /, "$1");
}
