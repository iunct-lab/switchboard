import type { Database } from "bun:sqlite";
import { OWNER, USED_ANSWERS_KEPT, USED_ANSWERS_KEY } from "../../merge-grants.ts";
import type { Columns, Migration } from "../migration.ts";

/** Set once the answers only the grants' table knew were written into the setting the release before reads. */
const CARRIED_KEY = "mergeGrantAnswersCarried";

function run(db: Database, columns: Columns) {
  // a merge / answer grant holds for the head the PR had when the grant was given (`head`). A grant from before the column
  // has none ('') and answers for no head: the person is asked again, which is the safe side
  if (!columns("task_grants").has("head")) db.exec("ALTER TABLE task_grants ADD COLUMN head TEXT NOT NULL DEFAULT ''");
  // the answers an older release remembered as used (the setting `mergeGrantAnswers`) become spent sources whenever the
  // setting is found, not once: a release rolled back to writes the setting again, and an answer it used must not give
  // its grants a second time after the newer release is back. The setting is left where it is (this release does not
  // read it anywhere else): the older release reads it after a rollback, and the inserts below are the same every start.
  // The other way round too, every start: an answer this table knows as spent and the setting lacks (spent while no
  // release wrote both places) is written into the setting, so the older release does not give its grants again either.
  // The setting keeps that release's form — an array of ids, oldest first, the newest `USED_ANSWERS_KEPT` of them — and
  // what it holds stays unless the bound drops it, as that release's own write does. An id the setting already holds keeps its
  // place; the ids only the table knows follow it, oldest first. A start that finds nothing to add writes nothing
  const used = db.query("SELECT json FROM settings WHERE key = ?").get(USED_ANSWERS_KEY) as { json: string } | null;
  db.transaction(() => {
    let parsed: unknown = [];
    try {
      parsed = used ? JSON.parse(used.json) : [];
    } catch {}
    const ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x !== "") : [];
    const spent = db.query(`INSERT OR IGNORE INTO task_grants (task_id, repo, kind, target, by, source, at) VALUES ('', '', 'spent', 0, '${OWNER}', ?, 0)`);
    for (const id of ids) spent.run(id);
    const known = db.query("SELECT source, MAX(at) AS at FROM task_grants WHERE source != '' GROUP BY source").all() as Array<{ source: string; at: number }>;
    const had = new Set(ids);
    // the ids this table spent itself (it has a time for them; one without came from the setting, and the bound dropped
    // it there since: it is not brought back, or every start would push out more) follow what the setting holds, in the
    // order they were spent. When the bound is
    // passed, what goes is the front of the setting — its own oldest, which that release's next write would drop first —
    // never its newest (it may have spent that one a moment ago, while rolled back) and never the ids added here
    const added = known.filter((k) => !had.has(k.source) && k.at > 0).sort((x, y) => x.at - y.at || (x.source < y.source ? -1 : x.source > y.source ? 1 : 0)).map((k) => k.source);
    // once: after it, every answer spent here is written to both places as it is spent, and what the setting's bound drops
    // later is that release's own forgetting. Carried again at every start, an id the bound dropped would come back at the
    // end and push out the next one, start after start, until it reached an answer that release spent while rolled back
    if (db.query("SELECT 1 FROM settings WHERE key = ?").get(CARRIED_KEY)) return;
    db.query("INSERT INTO settings (key, json) VALUES (?, 'true') ON CONFLICT(key) DO NOTHING").run(CARRIED_KEY);
    if (!added.length) return;
    const kept = [...ids, ...added].slice(-USED_ANSWERS_KEPT);
    if (JSON.stringify(kept) !== JSON.stringify(ids)) db.query("INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(USED_ANSWERS_KEY, JSON.stringify(kept));
  })();
}

export const migration: Migration = { number: 49, name: "task-grants-head", run };
