/** Read by tests only: the rows of the table in docs/design/pbi-progress.md, as facts and the answers they must give. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PbiFacts, PbiProgress } from "./pbi-progress.ts";

const COLUMNS = ["Row", "pbi", "decision", "status", "tasks", "others", "confirms", "decided", "held", "asked", "closableByApi", "closable", "prereqMet", "closesOnAnswer"];

export function readProgressTable(): Array<{ row: string; facts: PbiFacts; want: PbiProgress }> {
  const doc = readFileSync(join(import.meta.dir, "../../../docs/design/pbi-progress.md"), "utf8").split("\n");
  const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim().replaceAll("`", ""));
  const head = doc.findIndex((l) => l.startsWith("| Row |"));
  if (head < 0 || cells(doc[head]!).join() !== COLUMNS.join()) throw new Error(`docs/design/pbi-progress.md: the table's columns are not ${COLUMNS.join(" | ")}`);
  const rest = doc.slice(head + 2);
  const end = rest.findIndex((l) => !l.startsWith("|"));
  const bool = (c: string, where: string) => {
    if (c !== "yes" && c !== "no") throw new Error(`${where}: ${c} is neither yes nor no`);
    return c === "yes";
  };
  const list = (c: string) => (c === "-" ? [] : c.split(",").map((n) => Number(n.trim())));
  return rest.slice(0, end < 0 ? rest.length : end).map((l) => {
    const c = cells(l);
    if (c.length !== COLUMNS.length) throw new Error(`docs/design/pbi-progress.md: row "${c[0]}" has ${c.length} cells`);
    const [row, pbi, decision, status, tasks, others, confirms, decided, held, asked, closableByApi, closable, prereqMet, closesOnAnswer] = c as [string, string, string, string, string, string, string, string, string, string, string, string, string, string];
    const [done, total] = tasks.split("/").map(Number) as [number, number];
    return {
      row,
      facts: { pbi: bool(pbi, row), decision: bool(decision, row), status: status === "-" ? null : status, tasks: { total, done }, others: Number(others), confirms: list(confirms), decided: list(decided), held: bool(held, row) },
      want: { asked: list(asked), closableByApi: bool(closableByApi, row), closable: bool(closable, row), prereqMet: bool(prereqMet, row), closesOnAnswer: closesOnAnswer === "-" ? null : Number(closesOnAnswer) },
    };
  });
}
