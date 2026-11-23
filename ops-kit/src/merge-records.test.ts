import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLocation, mergeRecords } from "./merge-records.ts";

test("the app is found by MERGE_RECORDS_*, else by the Task's BACKLOG_*, and with neither it throws", () => {
  expect(appLocation({ BACKLOG_URL: "http://127.0.0.1:1234/api/backlog", BACKLOG_TOKEN_FILE: "/b" })).toEqual({ url: "http://127.0.0.1:1234", tokenFile: "/b" });
  expect(appLocation({ MERGE_RECORDS_URL: "http://127.0.0.1:5", MERGE_RECORDS_TOKEN_FILE: "/m", BACKLOG_URL: "http://127.0.0.1:1234/api/backlog", BACKLOG_TOKEN_FILE: "/b" })).toEqual({ url: "http://127.0.0.1:5", tokenFile: "/m" });
  expect(() => appLocation({})).toThrow();
  // an address is never used with the key of another source
  expect(() => appLocation({ MERGE_RECORDS_URL: "http://127.0.0.1:5" })).toThrow();
  expect(() => appLocation({ MERGE_RECORDS_URL: "http://127.0.0.1:5", BACKLOG_TOKEN_FILE: "/b" })).toThrow();
  expect(() => appLocation({ BACKLOG_URL: "http://127.0.0.1:1234/api/backlog" })).toThrow();
});

test("mergeRecords sends the repository, every PR, the Task and the head with the key, and throws when the app cannot answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-records-"));
  try {
    writeFileSync(join(dir, "token"), "k1\n");
    const env = { MERGE_RECORDS_URL: "http://127.0.0.1:47900", MERGE_RECORDS_TOKEN_FILE: join(dir, "token") };
    const seen: Array<{ url: string; auth: string | null }> = [];
    const ok = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ jobs: [], granted: null, direct: false });
    };
    expect(await mergeRecords(env, { repo: "o/a", prs: [3, 4], taskId: "t1", head: "c".repeat(40) }, ok)).toEqual({ jobs: [], granted: null, direct: false });
    expect(seen).toEqual([{ url: `http://127.0.0.1:47900/api/merge-records?repo=o%2Fa&pr=3&pr=4&taskId=t1&head=${"c".repeat(40)}`, auth: "Bearer k1" }]);
    await expect(mergeRecords({}, { repo: "o/a", prs: [3] }, ok)).rejects.toThrow();
    await expect(mergeRecords(env, { repo: "o/a", prs: [3] }, async () => Response.json({ error: "x" }, { status: 500 }))).rejects.toThrow();
    await expect(mergeRecords(env, { repo: "o/a", prs: [3] }, async () => Response.json({ error: "x" }, { status: 400 }))).rejects.toThrow();
    await expect(mergeRecords(env, { repo: "o/a", prs: [3] }, async () => { throw new Error("refused"); })).rejects.toThrow();
    await expect(mergeRecords(env, { repo: "o/a", prs: [3] }, async () => Response.json({ nothing: 1 }))).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
