/**
 * How far a PBI is: the one place that decides whether its user checks are asked now, whether it can be closed, whether
 * a PBI that names it as a prerequisite goes on, and whether answering a check closes it. The asks screen, Home, the
 * Backlog and the parallel guard read these answers and write none of the rules themselves. The table of every
 * combination is docs/design/pbi-progress.md; a test reads that table against this function, so a new rule is a new row there.
 */

/** What is read of a PBI before anything is decided. */
export interface PbiFacts {
  /** A PBI (`type:pbi`); a request has no progress. */
  pbi: boolean;
  /** Held by an open question: the `needs-decision` label, or a Task's question that holds it. */
  decision: boolean;
  /** The Project's Status; null = not read (the parallel guard does not read the Project). */
  status: string | null;
  /** Its Tasks and how many are closed. */
  tasks: { total: number; done: number };
  /** Unchecked acceptance criteria that are not the user's checks. */
  others: number;
  /** The numbers of its unchecked user-check lines, dated ones and ones checked by a decision's answer too. */
  confirms: number[];
  /** The lines among `confirms` whose named decisions are all stored: the decisions' own cards ask, not the user's check. */
  decided: number[];
  /** One of those decisions is still open. */
  held: boolean;
}

export interface PbiProgress {
  /** The user-check lines asked now. None while a Task is open: what is not built cannot be checked. */
  asked: number[];
  /** Built and every Task closed: the API takes 閉じる, user checks left or not. */
  closableByApi: boolean;
  /** `closableByApi` with nothing left to ask and no named decision open: the screen offers 閉じる and backlog-next starts it. */
  closable: boolean;
  /** Left with only the user's checks: as a prerequisite it is met, since it waits for the person and not for more work. */
  prereqMet: boolean;
  /** The one line whose answer closes the PBI (the last one asked, nothing else in the way); null = no answer closes it. */
  closesOnAnswer: number | null;
}

const BUILDING: ReadonlySet<string | null> = new Set(["In progress", "In review"]);

export function pbiProgress(f: PbiFacts): PbiProgress {
  const allDone = f.tasks.total > 0 && f.tasks.done === f.tasks.total;
  const started = f.pbi && BUILDING.has(f.status);
  // a question holds closing and counting it met, not the user's checks: those are asked beside the question
  const asked = started && (f.tasks.total === 0 || allDone) ? f.confirms.filter((n) => !f.decided.includes(n)) : [];
  const closableByApi = started && !f.decision && allDone;
  const closable = closableByApi && asked.length === 0 && !f.held;
  return {
    asked,
    closableByApi,
    closable,
    prereqMet: f.pbi && !f.decision && allDone && f.confirms.length > 0 && f.others === 0,
    closesOnAnswer: closableByApi && !f.held && asked.length === 1 ? asked[0]! : null,
  };
}
