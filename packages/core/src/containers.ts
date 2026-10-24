import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Containers a task started through docker (#1418, docs/design/task-cleanup.md). The kit's `docker` front labels what
 * `docker run` / `create` make with LABEL_KEY=<task id> and appends the compose project of an `up` to the task's log
 * (one JSON line each: {project, cwd, globals}, globals being compose's own options such as `-f`). When the task ends, its projects are taken down (containers and networks,
 * never volumes or images) unless another open task's log names the same project, and its labelled containers are
 * removed. Through the docker CLI, so DOCKER_HOST and the host's dockerd start are the ones the task used.
 */
export const LABEL_KEY = "switchboard.task";

export type CleanupResult = { projects: string[]; containers: number; failed: number } | { skipped: string } | null;

async function run(cmd: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { ok: (await p.exited) === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

const projectsOf = (file: string): { project: string; cwd?: string; globals: string[] }[] => {
  try {
    return readFileSync(file, "utf8").split("\n").flatMap((l) => {
      try {
        const r = JSON.parse(l) as { project?: unknown; cwd?: unknown; globals?: unknown };
        const globals = Array.isArray(r.globals) && r.globals.every((g) => typeof g === "string") ? (r.globals as string[]) : [];
        return typeof r.project === "string" && r.project !== "" ? [{ project: r.project, cwd: typeof r.cwd === "string" ? r.cwd : undefined, globals }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

export async function cleanupContainers(taskId: string, opts: { logDir: string; isOpen: (taskId: string) => boolean }): Promise<CleanupResult> {
  const log = join(opts.logDir, `${taskId}.jsonl`);
  const mine = projectsOf(log);
  const docker = Bun.which("docker", { PATH: process.env.PATH ?? "" });
  // no log and no docker: the task never used it, and there is nothing to say
  if (docker === null && mine.length === 0) return null;
  if (docker === null) return { skipped: "docker が PATH にありません" };
  const up = await run([docker, "version", "--format", "{{.Server.Version}}"]);
  if (!up.ok) return { skipped: "dockerd が応答しません" };

  // a project that a task still open also started stays: its containers are that task's too
  const kept = new Set<string>();
  for (const f of existsSync(opts.logDir) ? readdirSync(opts.logDir) : []) {
    const id = f.endsWith(".jsonl") ? f.slice(0, -".jsonl".length) : "";
    if (id === "" || id === taskId || !opts.isOpen(id)) continue;
    for (const p of projectsOf(join(opts.logDir, f))) kept.add(p.project);
  }
  const projects: string[] = [];
  let failed = 0;
  for (const p of new Map(mine.map((m) => [m.project, m])).values()) {
    if (kept.has(p.project)) continue;
    const r = await run([docker, "compose", ...p.globals, "-p", p.project, "down", "--remove-orphans"], p.cwd && existsSync(p.cwd) ? p.cwd : opts.logDir);
    if (r.ok) projects.push(p.project);
    else failed++;
  }
  const ids = (await run([docker, "ps", "-aq", "--filter", `label=${LABEL_KEY}=${taskId}`])).out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  let containers = 0;
  if (ids.length > 0) {
    if ((await run([docker, "rm", "-f", ...ids])).ok) containers = ids.length;
    else failed += ids.length;
  }
  rmSync(log, { force: true });
  if (failed > 0 && projects.length === 0 && containers === 0) return { skipped: `片付けが ${failed} 件失敗しました` };
  return projects.length === 0 && containers === 0 && failed === 0 ? null : { projects, containers, failed };
}
