/** Test helper: a tiny git repository shaped like Switchboard (root package named "switchboard", a daemon entry, a web build). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./releases.ts";

/** A daemon that answers what sb-rescue checks. `extra` runs at boot (throw, exit later, …). */
export const daemonSource = (version: string, extra = "") => `
const port = Number(process.env.SWITCHBOARD_PORT);
${extra}
Bun.serve({
  port, hostname: "127.0.0.1",
  fetch(req, srv) {
    const path = new URL(req.url).pathname;
    if (path === "/api/health") return Response.json({ ok: true, version: ${JSON.stringify(version)}, repoRoot: process.env.SWITCHBOARD_REPO_ROOT, webUrl: process.env.SWITCHBOARD_WEB_URL ?? null, starterToken: process.env.SWITCHBOARD_STARTER_TOKEN ?? null });
    if (path === "/api/tasks") return Response.json([]);
    if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    return new Response("not found", { status: 404 });
  },
  websocket: { message() {} },
});
console.log("fixture daemon ${version} on " + port);
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); // a real daemon takes a moment to stop
`;

export async function commitFile(repo: string, path: string, content: string, message: string): Promise<string> {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  await run(["git", "add", "-A"], repo);
  await run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message], repo);
  return run(["git", "rev-parse", "HEAD"], repo);
}

export async function makeRepo(): Promise<{ root: string; repo: string; home: string; v1: string }> {
  const root = mkdtempSync(join(tmpdir(), "sb-rescue-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  await run(["git", "init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "switchboard", private: true, workspaces: ["apps/*"] }));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "web", private: true, scripts: { build: "mkdir -p dist && echo built > dist/index.html" } }));
  await run([process.execPath, "install"], repo);
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  const v1 = await commitFile(repo, "packages/core/src/main.ts", daemonSource("v1"), "v1");
  return { root, repo, home, v1 };
}

export async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

export async function until<T>(fn: () => T | Promise<T>, label: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await (async () => fn())().catch(() => null); // a throw (the file is being replaced, the port is not up yet) means "not yet"
    if (v) return v as NonNullable<T>;
    await Bun.sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

export const health = (port: number) => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => (r.ok ? (r.json() as Promise<{ ok: boolean; version: string; repoRoot: string }>) : null));
