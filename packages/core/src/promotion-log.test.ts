import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { promotionCounts, refusedFiles, type PromotionDecisionKind } from "./promotion-log.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-promotion-log-"));
  db = new Db(join(dir, "db.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("refusedFiles takes at most five file names and nothing that is not a list of strings", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  expect(refusedFiles({ files: names, fileCount: 7 })).toEqual({ files: ["a", "b", "c", "d", "e"], fileCount: 7 });
  // no count given: the number taken
  expect(refusedFiles({ files: ["a", "b"] })).toEqual({ files: ["a", "b"], fileCount: 2 });
  // a name is cut at 300 characters
  expect(refusedFiles({ files: ["x".repeat(400)], fileCount: 1 }).files[0]).toHaveLength(300);
  // a count that is not a number is the number taken
  expect(refusedFiles({ files: ["a"], fileCount: "9" })).toEqual({ files: ["a"], fileCount: 1 });
  for (const body of [null, undefined, "files", [], {}, { files: "a" }, { files: ["a", 1] }, { files: { 0: "a" } }]) expect(refusedFiles(body)).toEqual({ files: [], fileCount: 0 });
});

test("promotionCounts counts each kind inside the period and the switches of history.jsonl", () => {
  const now = Date.parse("2026-11-20T12:00:00+09:00");
  const day = 86_400_000;
  const put = (kind: PromotionDecisionKind, sha: string, at: number, files: string[] = []) => db.recordPromotionDecision({ sha, tag: `v-${sha}`, kind, tasks: 1, reason: `${kind} ${sha}`, files, fileCount: files.length }, at);
  put("waited", "s1", now - 1000);
  put("waited", "s2", now - 2 * day);
  put("refused", "s2", now - 3000, ["a.ts", "b.ts"]);
  put("no-restart", "s3", now - 2000);
  put("no-restart", "s4", now - 20 * day); // outside 3 days
  mkdirSync(join(dir, "releases"));
  const line = (ts: number, action: string) => JSON.stringify({ ts, action });
  writeFileSync(join(dir, "releases", "history.jsonl"), [line(now - 500, "promote-web"), line(now - 600, "promote"), line(now - 20 * day, "promote-web"), "not json"].join("\n"));
  const c = promotionCounts(db, dir, 3, now);
  expect({ asked: c.noRestartAsked, switched: c.noRestartSwitched, waited: c.waited, refused: c.refused }).toEqual({ asked: 1, switched: 1, waited: 2, refused: 1 });
  // newest first, a refusal with its files
  expect(c.recent.map((r) => `${r.kind}/${r.sha}`)).toEqual(["waited/s1", "no-restart/s3", "refused/s2", "waited/s2"]);
  expect(c.recent.find((r) => r.kind === "refused")).toMatchObject({ tag: "v-s2", firstAt: now - 3000, reason: "refused s2", files: ["a.ts", "b.ts"], fileCount: 2 });
  // 25 rows: only the newest 20 come back, the counts are of all
  for (let i = 0; i < 25; i++) put("waited", `m${i}`, now - 10 * i);
  const many = promotionCounts(db, dir, 3, now);
  expect(many.recent).toHaveLength(20);
  expect(many.waited).toBe(27);
});
