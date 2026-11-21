/**
 * Opens one pull request that moves the host's pinned tools to the newest version that has aged long enough, with the
 * sha256 lines of the three files that pin them. Neither this checkout's files nor the host change: the commit is built
 * from origin/main in a temporary index (the same shape as rollback-pr.ts) and only the branch `host-pins/bump` is
 * pushed. The pull request is reviewed and merged like any other.
 *
 * Exit: 0 = nothing to do, a dry run, a pull request opened or already open; 1 = a download disagrees with what the
 * distributor publishes (no pull request); 2 = cannot tell (a distributor or GitHub cannot be read).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostFetch, readPins, type FetchText, type Pin } from "./host-pins.ts";
import { rewrite, prBody, verifyFiles, PIN_FILES, type BodyRow, type PinFileName, type Texts } from "./host-pin-files.ts";
import { MIN_AGE_DAYS, SECURITY_MIN_AGE_DAYS, pickAged, releasesOf, type Release } from "./host-pin-releases.ts";
import { checkOrigin, must, spawnSh, type Sh } from "./release-tag.ts";

export interface Deps {
  sh: Sh;
  fetchText: FetchText;
  fetchBytes: (url: string) => Promise<ReadableStream<Uint8Array>>;
  now: () => Date;
  log: (line: string) => void;
  repo: string;
}

export const BRANCH = "host-pins/bump";

const PATHS: Record<PinFileName, string> = { devtools: "aws/host/devtools.sh", node: "aws/host/node.sh", dockerfile: "container/Dockerfile" };
const DAY_MS = 86_400_000;

interface Pick {
  pin: Pin;
  release: Release;
}

function parseArgs(args: string[]): { pr: boolean; minAgeDays: number; securityMinAgeDays: number } | string {
  const out = { pr: false, minAgeDays: MIN_AGE_DAYS, securityMinAgeDays: SECURITY_MIN_AGE_DAYS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pr") out.pr = true;
    else if (a === "--min-age-days" || a === "--security-min-age-days") {
      const raw = args[++i] ?? "";
      // `Number("")` is 0: an empty value would make the waiting period 0 days, so only digits are taken
      if (!/^\d+(\.\d+)?$/.test(raw)) return `${a} は 0 以上の数`;
      const n = Number(raw);
      if (a === "--min-age-days") out.minAgeDays = n;
      else out.securityMinAgeDays = n;
    } else return `知らない引数: ${a}`;
  }
  return out;
}

const short = (name: string) => name.replace(/_VERSION$/, "");

/** The commit's tree: origin/main with the three files replaced, built in a temporary index so no work tree or index of the clone is touched. */
function treeWith(sh: Sh, changed: Partial<Texts>): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "switchboard.host-pins."));
  try {
    const git = (...a: string[]) => ["env", `GIT_INDEX_FILE=${join(dir, "index")}`, "git", ...a];
    must(sh, git("read-tree", "origin/main"));
    for (const [file, text] of Object.entries(changed) as [PinFileName, string][]) {
      const path = PATHS[file];
      const mode = must(sh, git("ls-files", "-s", "--", path)).split(/\s+/)[0];
      if (!mode) throw new Error(`origin/main に ${path} が無い`);
      const blob = must(sh, ["git", "hash-object", "-w", "--stdin"], text);
      must(sh, git("update-index", "--cacheinfo", `${mode},${blob},${path}`));
    }
    return must(sh, git("write-tree"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function main(args: string[], deps: Deps): Promise<0 | 1 | 2> {
  const { sh, log } = deps;
  const opts = parseArgs(args);
  if (typeof opts === "string") {
    log(`使い方: bun scripts/bump-host-pins.ts [--pr] [--min-age-days N] [--security-min-age-days N]（${opts}）`);
    return 2;
  }
  const now = deps.now();
  let texts: Texts;
  let picks: Pick[];
  try {
    must(sh, ["git", "fetch", "origin", "main"]);
    // a work tree's files can be ahead of or behind main: what is read is main's
    const show = (p: string) => must(sh, ["git", "show", `origin/main:${p}`]);
    // the shell's output is trimmed; the files end with a newline
    const nl = (s: string) => `${s}\n`;
    texts = { devtools: nl(show(PATHS.devtools)), node: nl(show(PATHS.node)), dockerfile: nl(show(PATHS.dockerfile)) };
    const { pins, unreadable } = readPins(texts.node, texts.devtools);
    if (unreadable.length) throw new Error(`${unreadable.join(",")}: 固定の行が読めない`);
    const why: string[] = [];
    picks = [];
    await Promise.all(
      // a pin that is not in PIN_FILES is not raised automatically
      pins.filter((p) => p.name in PIN_FILES).map(async (pin) => {
        try {
          const release = pickAged(await releasesOf(pin, deps.fetchText), pin.pinned, now, opts);
          if (release) picks.push({ pin, release });
        } catch (e) {
          why.push(`${pin.name}: ${(e as Error).message}`);
        }
      }),
    );
    if (why.length) throw new Error(why.sort().join(" / "));
    picks.sort((a, b) => a.pin.name.localeCompare(b.pin.name));
  } catch (e) {
    log(`判定できない（${(e as Error).message}）`);
    return 2;
  }
  if (picks.length === 0) {
    log("更新なし");
    return 0;
  }
  const line = (p: Pick) =>
    `${short(p.pin.name)} ${p.pin.pinned} → ${p.release.version}（公開 ${p.release.published.slice(0, 10)}、${Math.floor((now.getTime() - Date.parse(p.release.published)) / DAY_MS)} 日経過${p.release.security ? "、セキュリティ修正" : ""}）`;
  for (const p of picks) log(line(p));
  if (!opts.pr) {
    log("試し（--pr なし）: 何も書かない");
    return 0;
  }

  try {
    checkOrigin(sh, deps.repo);
    const open = must(sh, ["gh", "pr", "list", "-R", deps.repo, "--head", BRANCH, "--state", "open", "--json", "number", "-q", ".[].number"]).split("\n").filter(Boolean);
    if (open.length) {
      log(`開いた PR #${open[0]} がある（新しく選べる版: ${picks.map((p) => `${short(p.pin.name)} ${p.release.version}`).join(", ")}）。作らない`);
      return 0;
    }
  } catch (e) {
    log(`判定できない（${(e as Error).message}）`);
    return 2;
  }

  const bumps: { name: string; version: string; shas: Record<string, string> }[] = [];
  const rows: BodyRow[] = [];
  try {
    for (const { pin, release } of picks) {
      const v = await verifyFiles(pin.name, release.version, deps.fetchBytes, deps.fetchText);
      if (!v.ok) {
        log(`照合に失敗: ${v.why}`);
        return 1;
      }
      bumps.push({ name: pin.name, version: release.version, shas: v.shas });
      rows.push({
        name: pin.name,
        from: pin.pinned,
        to: release.version,
        published: release.published,
        urls: [...new Set(PIN_FILES[pin.name]!.map((f) => f.url(release.version)))],
        how: v.how,
        unpublished: v.unpublished,
      });
    }
  } catch (e) {
    log(`判定できない（${(e as Error).message}）`);
    return 2;
  }

  try {
    const next = rewrite(texts, bumps);
    const changed: Partial<Texts> = {};
    for (const f of Object.keys(PATHS) as PinFileName[]) if (next[f] !== texts[f]) changed[f] = next[f];
    const title = `chore(host): 固定版の道具を上げる: ${picks.map((p) => `${short(p.pin.name)} ${p.pin.pinned}→${p.release.version}`).join(", ")}`;
    const body = prBody(rows, { minAgeDays: opts.minAgeDays, securityMinAgeDays: opts.securityMinAgeDays, now });
    const commit = must(sh, ["git", "commit-tree", treeWith(sh, changed), "-p", "origin/main", "-m", title, "-m", body]);
    // The branch is this script's own and no PR is open on it (checked above): a rerun after a failed PR creation replaces it.
    must(sh, ["git", "push", "origin", `+${commit}:refs/heads/${BRANCH}`]);
    const url = must(sh, ["gh", "pr", "create", "-R", deps.repo, "--head", BRANCH, "--base", "main", "--title", title, "--body-file", "-"], body);
    log(`PR: ${url}`);
    return 0;
  } catch (e) {
    log(`PR を作れなかった（${(e as Error).message}）`);
    return 2;
  }
}

if (import.meta.main) {
  const repo = spawnSh(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (!repo.ok || !repo.out) {
    console.log("判定できない（リポジトリ名を読めない）");
    process.exit(2);
  }
  process.exit(
    await main(process.argv.slice(2), {
      sh: spawnSh,
      fetchText: hostFetch,
      fetchBytes: async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(600_000) });
        if (!r.ok || !r.body) throw new Error(`${new URL(url).host} answered ${r.status}`);
        return r.body;
      },
      now: () => new Date(),
      log: console.log,
      repo: repo.out,
    }),
  );
}
