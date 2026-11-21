// test-reads: packages/core/src/db/migrations/
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "switchboard.mig0051."))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("moves sent comments to their written time: the operation's time on remote and base, once; a comment no operation names, one whose operation is dated after it, and a local one, stay", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  const comment = (at: string, body = "b") => JSON.stringify({ issue: 12, body, createdAt: at });
  const put = raw.query("INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES ('github', 'github.com', 'acme/app', 'comment', ?, ?, ?, ?, 1000, 'fetched')");
  put.run("IC_sent", comment("2026-10-08T00:01:00Z"), comment("2026-10-08T00:01:00Z"), null);
  put.run("IC_other", comment("2026-10-09T00:00:00Z"), comment("2026-10-09T00:00:00Z"), null);
  put.run("local:x", null, null, comment("2026-10-08T00:00:00.000Z"));
  put.run("IC_now", comment("2026-10-08T00:01:00Z"), comment("2026-10-08T00:01:00Z"), null);
  put.run("IC_ahead", comment("2026-10-08T00:01:00Z"), comment("2026-10-08T00:01:00Z"), null);
  const written = Date.parse("2026-10-08T00:00:00.007Z");
  raw.query(`INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, field, payload, base, status, retry_at, created_at, updated_at)
             VALUES ('op1', 'github', 'github.com', 'acme/app', 'I_12', 'comment', 'IC_sent', 'comment', NULL, '{}', NULL, 'done', NULL, ?, ?)`).run(written, written);
  const now = Date.parse("2026-10-08T00:01:00.363Z"); // sent at once: GitHub's time is the same second, cut to it
  raw.query(`INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, field, payload, base, status, retry_at, created_at, updated_at)
             VALUES ('op3', 'github', 'github.com', 'acme/app', 'I_12', 'comment', 'IC_now', 'comment', NULL, '{}', NULL, 'done', NULL, ?, ?)`).run(now, now);
  const ahead = Date.parse("2026-10-08T00:02:00Z"); // a work machine's clock running ahead of the service's
  raw.query(`INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, field, payload, base, status, retry_at, created_at, updated_at)
             VALUES ('op2', 'github', 'github.com', 'acme/app', 'I_12', 'comment', 'IC_ahead', 'comment', NULL, '{}', NULL, 'done', NULL, ?, ?)`).run(ahead, ahead);
  raw.close();

  const read = () => {
    const r = new Database(path, { readonly: true });
    const rows = Object.fromEntries((r.query("SELECT external_id, remote, base, local FROM backlog_records WHERE object_kind = 'comment'").all() as Array<{ external_id: string; remote: string | null; base: string | null; local: string | null }>).map((x) => [x.external_id, x]));
    r.close();
    return rows;
  };
  new Db(path).close();
  const once = read();
  for (const col of ["remote", "base"] as const) expect(JSON.parse(once.IC_sent![col]!)).toEqual({ issue: 12, body: "b", createdAt: "2026-10-08T00:00:00.007Z" });
  expect(JSON.parse(once.IC_other!.remote!).createdAt).toBe("2026-10-09T00:00:00Z");
  expect(JSON.parse(once.IC_ahead!.remote!).createdAt).toBe("2026-10-08T00:01:00Z");
  expect(JSON.parse(once.IC_now!.remote!).createdAt).toBe("2026-10-08T00:01:00.363Z");
  expect(once["local:x"]).toEqual({ external_id: "local:x", remote: null, base: null, local: comment("2026-10-08T00:00:00.000Z") });
  new Db(path).close();
  expect(read()).toEqual(once);
});
