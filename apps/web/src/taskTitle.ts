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
