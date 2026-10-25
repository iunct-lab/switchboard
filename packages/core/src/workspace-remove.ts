import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Workspace } from "@switchboard/protocol";

export type CopyDeletable = { ok: true } | { ok: false; code: 400 | 409; reason: string };

/** Whether a workspace's directory may be deleted with its registration (#2600): only a Git checkout directly under the checkout's parent directory. */
export function copyDeletable(ws: Pick<Workspace, "kind" | "path">, repoRoot: string): CopyDeletable {
  if (ws.kind === "meta") return { ok: false, code: 400, reason: "meta workspace のディレクトリは消せません" };
  if (!existsSync(ws.path)) return { ok: true };
  let path: string, self: string;
  try {
    path = realpathSync(ws.path);
    self = realpathSync(repoRoot);
  } catch (e) {
    return { ok: false, code: 409, reason: `パスを確かめられないので消せません（${(e as Error).message}）` };
  }
  if (path === self) return { ok: false, code: 400, reason: "Switchboard 自身のディレクトリは消せません" };
  if (dirname(path) !== dirname(self)) return { ok: false, code: 400, reason: "Switchboard のチェックアウトの親ディレクトリの直下にないので消せません" };
  if (!existsSync(join(path, ".git"))) return { ok: false, code: 409, reason: "Git のチェックアウトではないので消せません" };
  return { ok: true };
}

async function git(path: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out: out.trim() };
}

/** What would be lost with the copy: uncommitted changes, commits not on the upstream (or any commit when there is no upstream). Reads only; no network. */
export async function inspectRemoval(path: string): Promise<{ dirty: boolean; unpushed: boolean }> {
  const status = await git(path, ["status", "--porcelain"]);
  const upstream = await git(path, ["log", "@{u}..HEAD", "--oneline"]);
  const unpushed = upstream.code === 0 ? upstream.out !== "" : (await git(path, ["log", "-1", "--oneline", "HEAD", "--not", "--remotes"])).out !== "";
  return { dirty: status.out !== "", unpushed };
}
