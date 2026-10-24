/** sb-rescue entry: make sure there is a current release, then run the daemon from it and keep it running. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendHistory, buildRelease, currentOf, switchTo } from "./releases.ts";
import { startRescue } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

const env = process.env;
if (!env.SWITCHBOARD_REPO_ROOT) {
  console.error("sb-rescue: set SWITCHBOARD_REPO_ROOT to the Switchboard checkout releases are built from");
  process.exit(2);
}
const repo = resolve(env.SWITCHBOARD_REPO_ROOT);
const home = env.SWITCHBOARD_HOME ? resolve(env.SWITCHBOARD_HOME) : join(homedir(), ".switchboard");
const port = Number(env.SWITCHBOARD_PORT ?? 47831);
const rescuePort = Number(env.SWITCHBOARD_RESCUE_PORT ?? 47841);

if (!currentOf(home)) {
  console.log("sb-rescue: no current release; building HEAD");
  const sha = await buildRelease(repo, "HEAD", home);
  switchTo(home, sha);
  appendHistory(home, { action: "install", from: null, to: sha, ok: true, reason: "first release" });
}
const supervisor = new Supervisor({ home, repo, port, rescueUrl: `http://127.0.0.1:${rescuePort}` });
supervisor.start();
const rescueHost = env.SWITCHBOARD_RESCUE_HOST ?? "127.0.0.1";
const starter = env.SWITCHBOARD_STARTER_URL && env.SWITCHBOARD_STARTER_TOKEN ? { url: env.SWITCHBOARD_STARTER_URL, token: env.SWITCHBOARD_STARTER_TOKEN } : undefined;
const rescue = startRescue({ home, repo, port, sup: supervisor }, { port: rescuePort, host: rescueHost, starter, beforeRebuild: env.SWITCHBOARD_REBUILD_SAVE_CMD ? [env.SWITCHBOARD_REBUILD_SAVE_CMD] : undefined, sessionPublicKey: /^[A-Za-z0-9_-]{43}$/.test(env.SWITCHBOARD_SESSION_PUBLIC_KEY ?? "") ? env.SWITCHBOARD_SESSION_PUBLIC_KEY : undefined, edge: env.SWITCHBOARD_EDGE_HEADER_VALUE || undefined, tmpOwned: env.SWITCHBOARD_RESCUE_OWNS_TMP === "1", exitToRestart: env.SWITCHBOARD_RESCUE_RESTART_BY_EXIT === "1" ? () => void rescue.stop().finally(() => process.exit(75)) : undefined });
console.log(`sb-rescue: daemon ${currentOf(home)} on port ${port}; log ${supervisor.logPath}`);
console.log(`sb-rescue: rescue page http://${rescueHost}:${rescuePort}/`);

const shutdown = async () => {
  await rescue.stop();
  await supervisor.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
