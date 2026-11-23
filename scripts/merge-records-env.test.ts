import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRecords } from "../ops-kit/src/merge-records.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { mergeRecordsEnv } from "./merge-records-env.ts";

const pick = (e: Record<string, string | undefined>) => {
  const r = mergeRecordsEnv(e);
  return [r.MERGE_RECORDS_URL, r.MERGE_RECORDS_TOKEN_FILE];
};

test("without the app's Task variables the address and key are those the daemon itself uses, and what was given stays as it is", () => {
  const home = mkdtempSync(join(tmpdir(), "merge-records-env-"));
  try {
    const cfg = loadConfig({ SWITCHBOARD_HOME: home });
    expect(pick({ SWITCHBOARD_HOME: home })).toEqual([`http://127.0.0.1:${cfg.port}`, cfg.tokenPath]);
    const own = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "47900", SWITCHBOARD_TOKEN_FILE: "/k" });
    expect(pick({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "47900", SWITCHBOARD_TOKEN_FILE: "/k" })).toEqual([`http://127.0.0.1:${own.port}`, own.tokenPath]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // a half-given pair is not completed from the defaults: the client then refuses it
  expect(pick({ BACKLOG_URL: "http://127.0.0.1:1234/api/backlog", SWITCHBOARD_PORT: "9" })).toEqual([undefined, undefined]);
  expect(pick({ MERGE_RECORDS_URL: "http://127.0.0.1:5", MERGE_RECORDS_TOKEN_FILE: "/m" })).toEqual(["http://127.0.0.1:5", "/m"]);
});

test("without BACKLOG_URL the app is looked for at the loopback port: an env filled by mergeRecordsEnv reaches the app with the default port and key", async () => {
  const home = mkdtempSync(join(tmpdir(), "merge-records-env-"));
  try {
    writeFileSync(join(home, "token"), "k9\n");
    const seen: Array<{ url: string; auth: string | null }> = [];
    const f = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ jobs: [], granted: null, direct: false });
    };
    const env = mergeRecordsEnv({ SWITCHBOARD_HOME: home });
    expect(env.BACKLOG_URL).toBeUndefined();
    expect(await mergeRecords(env, { repo: "o/a", prs: [3] }, f)).toEqual({ jobs: [], granted: null, direct: false });
    expect(seen).toEqual([{ url: `http://127.0.0.1:${loadConfig({ SWITCHBOARD_HOME: home }).port}/api/merge-records?repo=o%2Fa&pr=3`, auth: "Bearer k9" }]);
    // and the raw environment of a terminal is not enough for the client by itself
    await expect(mergeRecords({ SWITCHBOARD_HOME: home }, { repo: "o/a", prs: [3] }, f)).rejects.toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
