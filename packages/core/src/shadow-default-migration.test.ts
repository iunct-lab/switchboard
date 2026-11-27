import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-shadow-default-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Put a settings row into a database file, then open the file again so the migrations run over it. */
function reopenWith(file: string, json: string): Record<string, unknown> {
  let db = new Db(file);
  db.sqlite.query("INSERT OR REPLACE INTO settings (key, json) VALUES ('settings', ?)").run(json);
  db.close();
  db = new Db(file);
  const row = db.sqlite.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string };
  db.close();
  return JSON.parse(row.json);
}

test("shadow default migration: a saved custom: default becomes null; a built-in default, the per-kind parallel runs and the other keys stay", () => {
  const moved = reopenWith(join(dir, "custom.db"), JSON.stringify({ shadowRunner: "custom:sample", other: 1, autoStart: { runner: "claude", model: "", byKind: { review: { shadow: "custom:sample" } } } }));
  expect(moved.shadowRunner).toBeNull();
  expect(moved.other).toBe(1);
  expect((moved.autoStart as { byKind: unknown }).byKind).toEqual({ review: { shadow: "custom:sample" } });

  const kept = reopenWith(join(dir, "codex.db"), JSON.stringify({ shadowRunner: "codex", other: 1 }));
  expect(kept).toMatchObject({ shadowRunner: "codex", other: 1 }); // migration 32 adds autoStart to a row without it
});

test("shadow default migration: a malformed settings row is left alone", () => {
  expect(() => reopenWith(join(dir, "bad.db"), "{not json")).toThrow();
  const db = new Db(join(dir, "bad.db"));
  const row = db.sqlite.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string };
  expect(row.json).toBe("{not json");
  db.close();
});
