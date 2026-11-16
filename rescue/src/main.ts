/** sb-rescue entry: make sure there is a current release, then run the daemon from it and keep it running. */
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSource } from "./github-release.ts";
import { appendHistory, buildRelease, currentOf, releasesDir, switchTo } from "./releases.ts";
import { startRescue } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

const env = process.env;

/** The `owner/name` in update-source.json, or a message and exit 2 when the file cannot be read as one. */
function readSource(file: string): string {
  let value: unknown;
  try {
    value = (JSON.parse(readFileSync(file, "utf8")) as { source?: unknown } | null)?.source;
  } catch (e) {
    value = undefined;
    console.error(`sb-rescue: ${file} is not JSON: ${String((e as Error).message ?? e)}`);
  }
  try {
    if (typeof value !== "string") throw new Error("no source");
    checkSource(value);
    return value;
  } catch {
    console.error(`sb-rescue: ${file} must hold {"source":"owner/name"}; run the install again to write it`);
    process.exit(2);
  }
}
const home = env.SWITCHBOARD_HOME ? resolve(env.SWITCHBOARD_HOME) : join(homedir(), ".switchboard");
// Two ways to get releases: a checkout (SWITCHBOARD_REPO_ROOT) or, without one, the repository named in update-source.json.
const sourceFile = join(home, "update-source.json");
let source: string | null = null;
if (!env.SWITCHBOARD_REPO_ROOT) {
  if (!existsSync(sourceFile)) {
    console.error("sb-rescue: set SWITCHBOARD_REPO_ROOT to the Switchboard checkout releases are built from");
    process.exit(2);
  }
  source = readSource(sourceFile);
  if (!currentOf(home)) {
    console.error("sb-rescue: no release is built yet; run the install first");
    process.exit(2);
  }
}
const repo = source ? join(releasesDir(home), "current") : resolve(env.SWITCHBOARD_REPO_ROOT!);
const port = Number(env.SWITCHBOARD_PORT ?? 47831);
const rescuePort = Number(env.SWITCHBOARD_RESCUE_PORT ?? 47841);

if (!source && !currentOf(home)) {
  console.log("sb-rescue: no current release; building HEAD");
  const sha = await buildRelease(repo, "HEAD", home);
  switchTo(home, sha);
  appendHistory(home, { action: "install", from: null, to: sha, ok: true, reason: "first release" });
}
const supervisor = new Supervisor({ home, repo, source, port, rescueUrl: `http://127.0.0.1:${rescuePort}` });
supervisor.start();
const rescueHost = env.SWITCHBOARD_RESCUE_HOST ?? "127.0.0.1";
const starter = env.SWITCHBOARD_STARTER_URL && env.SWITCHBOARD_STARTER_TOKEN ? { url: env.SWITCHBOARD_STARTER_URL, token: env.SWITCHBOARD_STARTER_TOKEN } : undefined;
const rescue = startRescue({ home, repo, source, port, sup: supervisor }, { port: rescuePort, host: rescueHost, starter, beforeRebuild: env.SWITCHBOARD_REBUILD_SAVE_CMD ? [env.SWITCHBOARD_REBUILD_SAVE_CMD] : undefined, sessionPublicKey: /^[A-Za-z0-9_-]{43}$/.test(env.SWITCHBOARD_SESSION_PUBLIC_KEY ?? "") ? env.SWITCHBOARD_SESSION_PUBLIC_KEY : undefined, edge: env.SWITCHBOARD_EDGE_HEADER_VALUE || undefined, tmpOwned: env.SWITCHBOARD_RESCUE_OWNS_TMP === "1", exitToRestart: env.SWITCHBOARD_RESCUE_RESTART_BY_EXIT === "1" ? () => void rescue.stop().finally(() => process.exit(75)) : undefined });
console.log(`sb-rescue: daemon ${currentOf(home)} on port ${port}; log ${supervisor.logPath}`);
console.log(`sb-rescue: rescue page http://${rescueHost}:${rescuePort}/`);

const shutdown = async () => {
  await rescue.stop();
  await supervisor.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
