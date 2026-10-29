/**
 * bun scripts/update-clis.ts — updates the host's claude / codex CLIs when npm has a newer one, checks that one turn
 * still runs through the adapter, and puts the old version back when it does not (PBI #1626, docs/design/cli-update.md).
 *
 * One line per runner:
 *   <runner> version: <v>（最新）                      — nothing to do
 *   <runner> updated: <old> → <new>（確認 ok）          — updated, and one read-only turn came back
 *   <runner> rolled back: <new> → <old>（確認 失敗: …） — the update or the turn failed; the symlink is back on <old>
 *   <runner> 戻せなかった: …                            — it failed and the old version could not be put back
 *   <runner> version / latest: 分からない（…）          — the CLI is missing or the registry could not be read
 * Exit 0 = up to date or updated and checked / 1 = rolled back, could not roll back, or the update failed / 2 = cannot tell.
 *
 * Each CLI's own `update` flips a symlink to the new version and keeps the old files, so rolling back is flipping the
 * symlink to where it pointed before. Running Tasks keep the files they started with; only Tasks that start later use the new CLI.
 *
 * --file-request: on exit 1 also file a request Issue (type:request) through scripts/file-request.ts, unless an open
 * request has the same title (the same failure the next day does not file twice). The body has the `## 要望` and `## 出典`
 * sections the filing entry (scripts/setup/request_issue.sh) requires.
 */
import { existsSync, lstatSync, mkdtempSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createClaudeAdapter } from "../packages/adapters/claude/src/index.ts";
import { createCodexAdapter } from "../packages/adapters/codex/src/index.ts";
import { readOnlyMode, runSuggestionTurn } from "../packages/core/src/suggest-llm.ts";
import { compareVersions, hostVersions, type Runner, type VersionReaders } from "./check-models";
import { fileRequest } from "./file-request";

/** The symlink each CLI's `update` flips: claude `~/.local/bin/claude` → versions/<v>, codex `…/standalone/current` → releases/<v>-<triple>. */
export const LINKS: Record<Runner, string> = {
  claude: join(homedir(), ".local", "bin", "claude"),
  codex: join(homedir(), ".codex", "packages", "standalone", "current"),
};

const RUNNERS: Runner[] = ["claude", "codex"];

export interface UpdateDeps {
  versions: VersionReaders;
  update(runner: Runner): Promise<{ code: number; out: string }>;
  /** One read-only turn through the adapter; throws when it does not come back. */
  smoke(runner: Runner): Promise<void>;
  readLink(path: string): string;
  /** Points `path` at `target` without a moment where `path` does not exist (a temporary link in the same directory, then rename). */
  swapLink(path: string, target: string): void;
}

export interface Failure {
  runner: Runner;
  from: string;
  to: string;
  reason: string;
  /** Whether the old version is running again. */
  restored: boolean;
}

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

export async function updateClis(deps: UpdateDeps, links: Record<Runner, string> = LINKS): Promise<{ lines: string[]; code: 0 | 1 | 2; failures: Failure[] }> {
  const lines: string[] = [];
  const failures: Failure[] = [];
  let code: 0 | 1 | 2 = 0;
  const worse = (c: 1 | 2) => {
    if (code === 0 || (code === 2 && c === 1)) code = c; // a failure (1) says more than "cannot tell" (2)
  };
  for (const runner of RUNNERS) {
    let installed: string | null;
    let latest: string;
    try {
      installed = await deps.versions.installed(runner);
      if (installed === null) {
        lines.push(`${runner} version: 分からない（${runner} が PATH に無い）`);
        worse(2);
        continue;
      }
      latest = await deps.versions.latest(runner);
    } catch (e) {
      lines.push(`${runner} latest: 分からない（${short((e as Error).message)}）`);
      worse(2);
      continue;
    }
    if (compareVersions(installed, latest) >= 0) {
      lines.push(`${runner} version: ${installed}（最新）`);
      continue;
    }
    const link = links[runner];
    let before: string;
    try {
      before = deps.readLink(link);
    } catch (e) {
      lines.push(`${runner} version: 分からない（戻し先を読めないので更新しない: ${short((e as Error).message)}）`);
      worse(2);
      continue;
    }
    let reached = latest; // what the update actually installed, once it can be read (npm's latest is only what was asked for)
    const fail = async (reason: string) => {
      let restored = false;
      let detail = "";
      try {
        const seen = await deps.versions.installed(runner).catch(() => null); // before restoring: what the update left (a failed update can still have installed)
        if (seen !== null && compareVersions(seen, installed) > 0) reached = seen;
      } catch {}
      try {
        let current: string | null = null;
        try {
          current = deps.readLink(link);
        } catch {} // a link the update removed or left dangling is put back too
        if (current !== before) deps.swapLink(link, before);
        const now = await deps.versions.installed(runner);
        restored = now === installed;
        if (!restored) detail = `--version が ${now ?? "無し"}`;
      } catch (e) {
        detail = short((e as Error).message);
      }
      lines.push(
        restored
          ? `${runner} rolled back: ${reached} → ${installed}（確認 失敗: ${reason}）`
          : `${runner} 戻せなかった: ${installed} → ${reached} に更新したが ${reason}。戻し先 ${before} に戻せない（${detail}）`,
      );
      failures.push({ runner, from: installed, to: reached, reason, restored });
      worse(1);
    };
    const upd = await deps.update(runner).catch((e) => ({ code: -1, out: String((e as Error).message ?? e) }));
    if (upd.code !== 0) {
      await fail(`update が exit ${upd.code}: ${short(upd.out.split("\n").filter(Boolean).pop() ?? "")}`);
      continue;
    }
    let now: string | null = null;
    try {
      now = await deps.versions.installed(runner);
    } catch (e) {
      await fail(`更新後の --version が読めない: ${short((e as Error).message)}`);
      continue;
    }
    if (now !== null && compareVersions(now, installed) > 0) reached = now;
    if (now === null || compareVersions(now, installed) <= 0) {
      await fail(`update のあとも版が ${now ?? "無し"} のまま`);
      continue;
    }
    try {
      await deps.smoke(runner);
    } catch (e) {
      await fail(`1 ターンが通らない: ${short((e as Error).message)}`);
      continue;
    }
    lines.push(`${runner} updated: ${installed} → ${now}（確認 ok）`);
  }
  return { lines, code, failures };
}

/** The title is the same for the same failure, so the next day's identical failure finds the open request. */
export function requestFor(failures: Failure[], date: string, lines: string[]): { title: string; body: string } | null {
  if (failures.length === 0) return null;
  const title = `CLI 更新の失敗: ${failures.map((f) => `${f.runner} ${f.from} → ${f.to}`).join(" / ")}`;
  const home = homedir();
  const body = [
    "## 要望",
    `${date} の定期実行（\`bun scripts/update-clis.ts --file-request\`）で CLI の更新に失敗した。`,
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    ...failures.map((f) => (f.restored ? `- ${f.runner}: 元の版 ${f.from} に戻した。次に更新するまで以後の Task は ${f.from} で動く` : `- ${f.runner}: **元の版に戻せていない**。ホストの ${LINKS[f.runner]} を確かめる`)),
    "",
    "直し方（docs/design/cli-update.md）: 新しい版でアダプタが動かない理由を直す。直るまで翌日も更新→失敗→戻すを繰り返す（同じ題の要望は増えない）。",
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `\`bun scripts/update-clis.ts --file-request\`（定期実行） / ${date}`,
  ]
    .join("\n")
    .replaceAll(home, "~"); // an Issue is public text: no username from the home path
  return { title, body };
}

const run = async (cmd: string[], ms: number) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), ms);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: out + err };
  } finally {
    clearTimeout(timer);
  }
};

export function hostDeps(): UpdateDeps {
  return {
    versions: hostVersions(),
    update: (runner) => run([runner, "update"], 5 * 60_000),
    async smoke(runner) {
      const adapter = runner === "claude" ? createClaudeAdapter() : createCodexAdapter(); // new adapter: the PATH's CLI is the new one
      const cwd = mkdtempSync(join(tmpdir(), "switchboard.update-clis."));
      try {
        await runSuggestionTurn({ adapter, cwd, permissionMode: readOnlyMode(adapter).mode }, "OK とだけ返してください。", AbortSignal.timeout(180_000));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    readLink(path) {
      if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) throw new Error(`${path} は symlink ではない（戻し先が分からない）`);
      return readlinkSync(path);
    },
    swapLink(path, target) {
      const tmp = join(dirname(path), `.${basename(path)}.update-clis`);
      rmSync(tmp, { force: true });
      symlinkSync(target, tmp);
      renameSync(tmp, path);
    },
  };
}

if (import.meta.main) {
  const { lines, code, failures } = await updateClis(hostDeps());
  for (const l of lines) console.log(l);
  if (process.argv.includes("--file-request") && code === 1) {
    try {
      const req = requestFor(failures, new Date().toISOString().slice(0, 10), lines);
      if (req) {
        const r = await fileRequest(req);
        if ("open" in r) console.log(`要望: 既存 ${r.open}（起票しない）`);
      }
    } catch (e) {
      console.log(`要望: 起票できなかった（${(e as Error).message}）`);
    }
  }
  process.exit(code);
}
