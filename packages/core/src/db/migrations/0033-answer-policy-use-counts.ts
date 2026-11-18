import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the answer policies gained the total of their uses and the first use; one saved before has neither and would not read as a
  // policy. What is left of its history gives them: the count of the kept uses and the oldest of them (a history already cut at 20 says no more).
  const policiesRow = db.query("SELECT json FROM settings WHERE key = 'answerPolicies'").get() as { json: string } | null;
  if (policiesRow) {
    try {
      const saved = JSON.parse(policiesRow.json) as unknown;
      const old = (p: unknown): p is { uses: Array<{ at: number }>; useCount?: number; firstUsedAt?: number | null } => !!p && typeof p === "object" && Array.isArray((p as { uses?: unknown }).uses) && (p as { useCount?: unknown }).useCount === undefined;
      if (Array.isArray(saved) && saved.some(old)) {
        for (const p of saved.filter(old)) {
          p.useCount = p.uses.length;
          p.firstUsedAt = p.uses.length ? Math.min(...p.uses.map((u) => u.at)) : null;
        }
        db.query("UPDATE settings SET json = ? WHERE key = 'answerPolicies'").run(JSON.stringify(saved));
      }
    } catch {
      // a malformed row is not touched: readPolicies drops what is not a whole policy
    }
  }
}

export const migration: Migration = { number: 33, name: "answer-policy-use-counts", run };
