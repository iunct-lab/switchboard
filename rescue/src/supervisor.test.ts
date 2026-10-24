import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import { buildRelease, switchTo } from "./releases.ts";
import { Supervisor } from "./supervisor.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
const sups: Supervisor[] = [];
beforeAll(async () => {
  f = await makeRepo();
  switchTo(f.home, await buildRelease(f.repo, "HEAD", f.home));
});
afterAll(async () => {
  for (const s of sups) await s.stop();
  rmSync(f.root, { recursive: true, force: true });
});

test("a broken working tree does not reach the running daemon, not even across a restart", async () => {
  const port = await freePort();
  const sup = new Supervisor({ home: f.home, repo: f.repo, port });
  sups.push(sup);
  sup.start();
  const h = await until(() => health(port), "daemon up");
  expect(h).toMatchObject({ ok: true, version: "v1", repoRoot: f.repo }); // the meta workspace stays the checkout
  writeFileSync(join(f.repo, "packages/core/src/main.ts"), "throw new Error('agent broke the tree');\n");
  await commitFile(f.repo, "packages/core/src/other.ts", "export {};\n", "agent commit");
  expect((await health(port))?.version).toBe("v1");
  await sup.restart();
  expect((await until(() => health(port), "daemon back")).version).toBe("v1");
  expect(sup.running).toBe(f.v1);
  expect(sup.logTail().some((l) => l.includes("fixture daemon v1"))).toBe(true);
});

test("exit 75 respawns at once; a crash loop ends in `failed` without touching the version", async () => {
  const port = await freePort();
  const again = await buildRelease(f.repo, await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v2", `if (process.env.SWITCHBOARD_PORT) setTimeout(() => process.exit(require("node:fs").existsSync(${JSON.stringify(join(f.root, "crash"))}) ? 1 : 75), 300);`), "v2 exits"), f.home);
  switchTo(f.home, again);
  const sup = new Supervisor({ home: f.home, repo: f.repo, port, backoffMs: 20, retries: 2 });
  sups.push(sup);
  sup.start();
  await until(() => sup.logTail().filter((l) => l.includes("asked for a restart")).length >= 2, "two respawns after exit 75");
  expect(sup.state).toBe("running");
  writeFileSync(join(f.root, "crash"), "");
  await until(() => sup.state === "failed", "gives up");
  expect(sup.logTail().some((l) => l.includes("gave up after 2 retries"))).toBe(true);
  expect(sup.running).toBe(again);
});
