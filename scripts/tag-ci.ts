/**
 * CI on the release tags (#2953): a tag is made without waiting for CI (scripts/release-tag.ts), and
 * `bun scripts/tag-ci.ts [--repo <owner/name>]` runs the same steps as local-ci (ci.yml's `run:` steps, `bun scripts/ci.ts`
 * as that checkout's scripts/ci.ts steps, the same environment) on the newest `vX.Y.Z` tag that has no result yet, and
 * adds the result to the end of that tag's GitHub Release: `[tag-ci] pass|fail <sha>`. A fail walks back to the tag
 * before it, until a pass or a tag that already has a result; the tags walked past are not run. A tag without a Release
 * is not run and the walk stops there (release-tag.ts makes the Release). A perf-ratchet check whose only finding is
 * `raised:` (a ceiling above main's, which an older tag has when main lowered it after) counts as a pass: `raised` is
 * the rule for a PR before its merge, not a result of a merged tag.
 * Output: one line of JSON, the tags looked at, newest first. Exit 0 = the newest tag passed (now or before), 1 = it
 * failed, 2 = nothing judged (no tag, no Release, not run).
 * Then for the newest tag (#2936; Switchboard itself, no --repo): a fail files a request (type:request, from a
 * scheduled check) unless one with the same title is open, which gets a comment naming the tag instead; a pass comments
 * on the open tag-CI requests (they stay open: the PBI that fixed it closes them). What an open request already says is
 * not said again. With --repo no request is filed: a fail prints the request's text to stderr on every run (the
 * scheduled Task reports it as its stop).
 * `--latest-pass [--contained-in <commit>]` (#2962) runs nothing: it prints the newest tag whose last result is pass
 * (a fail, no result and no Release are passed over), only from the tags in `<commit>`'s history when given (the
 * public sync gives the running release's commit). Exit 0 = printed, 1 = no tag passed (prints nothing), 2 = bad
 * arguments or an unknown commit.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findSecrets, hostAws, type HostAws } from "../ops-kit/src/secrets.ts";
import { FILE_DEPS, type Filed, type OpenRequest, commentRequest, fileRequest, openRequests, requestText } from "./file-request.ts";
import { remoteRepo, runCheckout, step, stepEnv, TargetError, type Deps } from "./local-ci.ts";

/** A result's line in a Release's body: pass or fail, then the tag's commit. */
export const TAG_CI_RESULT = /^\[tag-ci\] (pass|fail) ([0-9a-f]{40})(?=\s|$)/m;

/** The last result of `sha` in a Release's body, or null: a later run's line outweighs an earlier one. */
export function tagResult(releaseBody: string, sha: string): "pass" | "fail" | null {
  let last: "pass" | "fail" | null = null;
  for (const m of releaseBody.matchAll(new RegExp(TAG_CI_RESULT.source, "gm"))) if (m[2] === sha) last = m[1] as "pass" | "fail";
  return last;
}

/** A line without host paths: the given roots (the worktree, its TMPDIR) by name, then any home directory as `~`. */
export function hidePaths(line: string, roots: Record<string, string> = {}, home = homedir()): string {
  let out = line;
  for (const [path, name] of Object.entries(roots)) out = out.replaceAll(path, name);
  return out.replaceAll(home, "~").replace(/\/(?:home|Users)\/[^/\s]+|\/root(?=\/|\s|$)/g, "~");
}

/**
 * What goes at the end of the Release's body: the mark, and for a fail (or a raised-only pass) the step and what it
 * named, at most 20 lines, without host paths. When the step's name or its lines have a value usable for auth
 * (`findSecrets`), none of them is written: the mark stays, a note says why the rest is missing.
 */
export function resultSection(r: { sha: string; ok: boolean; step?: string; fails?: string[]; raisedOnly?: boolean }, host: HostAws = hostAws()): string {
  const out = ["", "", "## CI", `[tag-ci] ${r.ok ? "pass" : "fail"} ${r.sha}${r.raisedOnly ? " (raised only)" : ""}`, "", "`bun scripts/tag-ci.ts` がこのタグのコミットで `.github/workflows/ci.yml` の手順（local-ci と同じ）を回した。"];
  // an unnamed step's name is its script's first line, which may hold a path or a value as much as its output
  const step = hidePaths(r.step ?? "");
  const detail = [
    ...(r.raisedOnly ? [`\`${step}\` は main より上げた上限（raised）だけで落ちた。マージ済みのタグでは pass と数える:`] : r.ok ? [] : [`\`${step}\` が落ちた:`]),
    ...(r.fails ?? []).slice(0, 20).map((l) => `    ${hidePaths(l)}`),
  ];
  if (detail.length === 0) return `${out.join("\n")}\n`;
  const safe = findSecrets(detail.join("\n"), host).length === 0;
  return `${[...out, "", ...(safe ? detail : ["（落ちた手順の名前か行に認証に使える値が含まれるので書かない。実行したホストの記録（~/.cache の下）を見る）"])].join("\n")}\n`;
}

const STRICT = /^v\d+\.\d+\.\d+$/;

/** The `vX.Y.Z` tags of the clone at `root`, newest first; with `merged`, only those in that commit's history. */
async function listTags(root: string, sh: (cmd: string[]) => Promise<string>, merged?: string): Promise<string[]> {
  const cmd = ["git", "-C", root, "tag", "-l", "v*", "--sort=-v:refname", ...(merged ? ["--merged", merged] : [])];
  return (await sh(cmd)).split("\n").map((t) => t.trim()).filter((t) => STRICT.test(t));
}

export interface TagCiDeps extends Omit<Deps, "sh"> {
  /** Runs a command; throws on a non-zero exit. `input` goes to its stdin. */
  sh: (cmd: string[], cwd?: string, input?: string) => Promise<string>;
}

/** `step` / `fails`: a fail run now, the failed step and its lines (without host paths). */
export interface TagCiEntry { tag: string; sha: string; result: "pass" | "fail"; ran: boolean; step?: string; fails?: string[] }

/** One tag's CI in its own worktree; the result to record. */
async function runTag(tag: string, sha: string, repo: string, root: string, d: TagCiDeps, cache: string) {
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, `switchboard.tag-ci-${tag}.`));
  const tmp = mkdtempSync(join(tmpdir(), `switchboard.tag-ci-${tag}-tmp.`));
  try {
    await d.sh(["git", "-C", root, "worktree", "add", "-q", "--detach", dir, sha]);
    const run = await runCheckout(dir, stepEnv(tmp), `tag-ci-${repo.replaceAll("/", "_")}`, d, cache);
    const failed = run.results.at(-1);
    const p = run.perf;
    // the check is the last step: a pass by raised only leaves no step unrun
    const raisedOnly = !run.ok && !!p && !p.unknown && p.raised.length > 0 && p.over.length + p.improved.length === 0
      && !!failed?.run.includes("perf-ratchet") && run.steps.at(-1)?.run === failed.run;
    const fails = raisedOnly ? p!.raised : [...(failed?.fails ?? []), ...(p?.raised ?? [])];
    return { sha, ok: run.ok || raisedOnly, step: failed?.name, fails: fails.map((l) => hidePaths(l, { [dir]: "<checkout>", [tmp]: "<tmp>" })), raisedOnly };
  } finally {
    await d.sh(["git", "-C", root, "worktree", "remove", "--force", dir]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Walks the tags of `repo` (its clone at `root`) newest first: see the file's comment. `cache`: the worktrees and failure logs (~/.cache; tests give their own). */
export async function tagCi(d: TagCiDeps, repo: string, root: string, cache = join(homedir(), ".cache"), host: HostAws = hostAws()): Promise<TagCiEntry[]> {
  await d.sh(["git", "-C", root, "fetch", "-q", "origin", "--tags", "--force"]);
  const tags = await listTags(root, d.sh);
  const out: TagCiEntry[] = [];
  for (const tag of tags) {
    const sha = (await d.sh(["git", "-C", root, "rev-parse", `${tag}^{commit}`])).trim();
    const body = await d.sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    if (body === null) {
      d.log(`${tag}: release が無いか読めない（release-tag.ts で作る）。ここで止める`);
      break;
    }
    const known = tagResult(body, sha);
    if (known) {
      d.log(`${tag}: 結果あり（${known}）`);
      out.push({ tag, sha, result: known, ran: false });
      break;
    }
    d.log(`${tag}（${sha.slice(0, 7)}）を回す`);
    const r = await runTag(tag, sha, repo, root, d, cache);
    await d.sh(["gh", "release", "edit", tag, "-R", repo, "--notes-file", "-"], undefined, `${body.trimEnd()}${resultSection(r, host)}`.trimStart());
    d.log(`${tag}: ${r.ok ? "pass" : "fail"}${r.raisedOnly ? "（raised only）" : ""}`);
    out.push({ tag, sha, result: r.ok ? "pass" : "fail", ran: true, ...(r.ok ? {} : { step: hidePaths(r.step ?? ""), fails: r.fails }) });
    if (r.ok) break;
  }
  return out;
}

/** The first tag of `tags` (newest first) whose result is pass, or null. Stops reading at it. */
export async function latestPass(tags: string[], resultOf: (tag: string) => Promise<"pass" | "fail" | null>): Promise<string | null> {
  for (const tag of tags) if ((await resultOf(tag)) === "pass") return tag;
  return null;
}

/** `--latest-pass`: see the file's comment. Reads the Releases of `repo`; runs and edits nothing. */
export async function latestPassTag(sh: TagCiDeps["sh"], repo: string, root: string, containedIn?: string): Promise<string | null> {
  await sh(["git", "-C", root, "fetch", "-q", "origin", "--tags", "--force"]);
  return latestPass(await listTags(root, sh, containedIn), async (tag) => {
    const sha = (await sh(["git", "-C", root, "rev-parse", `${tag}^{commit}`])).trim();
    const body = await sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    return body === null ? null : tagResult(body, sha);
  });
}

/** `--latest-pass` and `--contained-in <commit>` taken off the arguments; the rest is for resolveRepo. */
export function parseArgs(args: string[]): { latestPass: boolean; containedIn: string | undefined; rest: string[] } {
  const at = args.indexOf("--contained-in");
  const containedIn = at < 0 ? undefined : args[at + 1];
  if (at >= 0 && (!containedIn || containedIn.startsWith("--"))) throw new TargetError("--contained-in の後にコミットを書く");
  const latestPass = args.includes("--latest-pass");
  if (at >= 0 && !latestPass) throw new TargetError("--contained-in は --latest-pass と一緒に使う");
  return { latestPass, containedIn, rest: args.filter((a, i) => a !== "--latest-pass" && (at < 0 || (i !== at && i !== at + 1))) };
}

/** 0 = the newest tag passed, 1 = it failed, 2 = nothing judged. */
export const tagCiExit = (entries: TagCiEntry[]): number => (entries[0] === undefined ? 2 : entries[0].result === "pass" ? 0 : 1);

/** The start of every tag-CI request's title: a pass comments on the open ones. */
export const REQUEST_TITLE = "要望: タグの CI が ";

/**
 * The request for a failed newest tag. The title is the step and a hash of its lines, so the same failure (same step,
 * same `(fail)` / `over:` / `raised:` lines) gets the same title and fileRequest files it once. No host paths; when the
 * step, its lines or the commits hold a value usable for auth, they are left out and a note says so.
 */
export function failureRequest(
  r: { tag: string; sha: string; step: string; fails: string[]; lastPass: string | null; commits: string[] },
  date = new Date().toISOString().slice(0, 10),
  host: HostAws = hostAws(),
): { title: string; body: string } {
  const step = hidePaths(r.step);
  const fails = r.fails.map((l) => hidePaths(l));
  const commits = r.commits.map((l) => hidePaths(l));
  // the lines a Release keeps (at most 20): a fail read back from it gets the same title
  const hash = createHash("sha256").update(fails.slice(0, 20).join("\n")).digest("hex").slice(0, 8);
  const range = r.lastPass ? `${r.lastPass}..${r.tag}` : null;
  const detail = [
    `手順: ${step}`,
    "行:",
    ...(fails.length ? fails.slice(0, 20).map((l) => `  ${l}`) : ["  （行なし）"]),
    `最後に通ったタグ: ${r.lastPass ?? "不明（遡りで見つからない。前のタグの Release の [tag-ci] を見る）"}`,
    ...(range ? [`その間のコミット（${range}）:`, ...(commits.length ? commits.slice(0, 50).map((l) => `  ${l}`) : ["  （なし）"])] : []),
  ];
  const safe = findSecrets([step, ...detail].join("\n"), host).length === 0;
  // the title is the failure's alone (the step and the lines a Release keeps, as resultSection checks them): the commits
  // differ from run to run for the same failure
  const named = findSecrets([step, ...fails.slice(0, 20)].join("\n"), host).length === 0;
  const title = `${REQUEST_TITLE}${named ? step.slice(0, 80) : "（名前を書けない手順）"} で落ちる（${hash}）`;
  const body = [
    "## 要望",
    `タグの CI で最新のタグ ${r.tag} が落ちた。直してほしい（この要望は直した PBI が閉じる）。`,
    "",
    "````text",
    `落ちたタグ: ${r.tag}（${r.sha.slice(0, 7)}）`,
    ...(safe ? detail : ["（手順の名前・行・コミットに認証に使える値が含まれるので書かない。実行したホストの記録（~/.cache の下）を見る）"]),
    "````",
    "",
    `結果の全文は落ちたタグの Release の \`## CI\`（\`gh release view ${r.tag} --json body -q .body\`）。`,
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `- いつ: ${date}`,
    "- 経路: タグの CI（scripts/tag-ci.ts）",
    "",
    "## 添付",
    "なし",
    "",
    "## 派生 PBI",
    "",
    "## 解釈メモ",
    "- 同じ手順・同じ行の失敗は同じ題になる。次のタグも同じく落ちればこの要望にコメントが付き、あとのタグが通れば「<タグ> で通った」とコメントが付く（閉じない）",
  ].join("\n");
  return { title, body };
}

export interface FollowDeps {
  sh: TagCiDeps["sh"];
  log: (line: string) => void;
  file: (req: { title: string; body: string }) => Promise<Filed>;
  comment: (ref: string, body: string) => Promise<void>;
  open: () => Promise<OpenRequest[]>;
  /** An open request's body and comments: a comment already there is not posted again. */
  text: (ref: string) => Promise<string>;
  /** With --repo: where the request's text goes instead of filing it. */
  print: (text: string) => void;
}

/** The failed step and its lines as resultSection wrote them in a Release's body (the last ones), or null when it wrote none. */
export function failedIn(releaseBody: string): { step: string; fails: string[] } | null {
  const m = [...releaseBody.matchAll(/^`(.*)` が落ちた:\n((?: {4}.*(?:\n|$))*)/gm)].at(-1);
  return m ? { step: m[1]!, fails: m[2]!.split("\n").filter(Boolean).map((l) => l.slice(4)) } : null;
}

/** The newest tag before the walk's last one whose Release says pass, read without running (at most 50; a tag without a Release stops it). */
async function lastPassBefore(entries: TagCiEntry[], repo: string, root: string, sh: TagCiDeps["sh"]): Promise<string | null> {
  const seen = entries.find((e) => e.result === "pass");
  if (seen) return seen.tag;
  const tags = await listTags(root, sh);
  for (const tag of tags.slice(tags.indexOf(entries.at(-1)!.tag) + 1, tags.indexOf(entries.at(-1)!.tag) + 51)) {
    const sha = (await sh(["git", "-C", root, "rev-parse", `${tag}^{commit}`])).trim();
    const body = await sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    if (body === null) return null;
    if (tagResult(body, sha) === "pass") return tag;
  }
  return null;
}

/**
 * After the walk: see the file's comment. `self` = Switchboard itself (no --repo). It runs on every run, for the newest
 * tag whether it was run now or read from before, and says only what the open request does not say yet: a run whose
 * filing or comment failed is made up by the next one. A fail read from before is read back from its Release.
 */
export async function followUp(entries: TagCiEntry[], repo: string, root: string, self: boolean, d: FollowDeps, date?: string, host?: HostAws): Promise<void> {
  const newest = entries[0];
  if (!newest) return;
  if (newest.result === "pass") {
    if (!self) return;
    const said = `${newest.tag} で通った`;
    for (const o of (await d.open()).filter((o) => o.title.startsWith(REQUEST_TITLE))) {
      if ((await d.text(o.ref)).split("\n").some((l) => l.trim() === said)) continue;
      await d.comment(o.ref, said);
      d.log(`要望 ${o.ref}: ${said}とコメントした`);
    }
    return;
  }
  const failed = newest.ran
    ? { step: newest.step ?? "", fails: newest.fails ?? [] }
    : failedIn(await d.sh(["gh", "release", "view", newest.tag, "-R", repo, "--json", "body", "-q", ".body"]));
  if (failed === null) {
    d.log(`${newest.tag}: Release に落ちた手順が書かれていない（認証に使える値で省いた）。要望は立てない`);
    return;
  }
  const lastPass = await lastPassBefore(entries, repo, root, d.sh);
  const commits = lastPass ? (await d.sh(["git", "-C", root, "log", "--format=%h %s", `${lastPass}..${newest.tag}`])).split("\n").filter(Boolean) : [];
  const req = failureRequest({ tag: newest.tag, sha: newest.sha, ...failed, lastPass, commits }, date, host);
  if (!self) {
    d.print(`要望は立てない（--repo）。止まった理由として報告する:\n${req.title}\n\n${req.body}`);
    return;
  }
  const r = await d.file(req);
  if (!("open" in r)) {
    d.log(`要望を立てた: ${r.filed === null ? "番号不明" : `#${r.filed}`}`);
    return;
  }
  // the request's body (filed for this tag) or an earlier comment names the tag and its commit
  const named = `${newest.tag}（${newest.sha.slice(0, 7)}）`;
  if ((await d.text(r.open)).includes(named)) return;
  await d.comment(r.open, `${named}でも同じ失敗`);
  d.log(`要望: 既存 ${r.open} にコメントした（起票しない）`);
}

/** The repository and its clone from `[--repo <owner/name>]`, as local-ci's resolveTarget reads them (GitHub only: the results go on GitHub Releases). */
export async function resolveRepo(args: string[], cwd: string, scriptRoot: string, run: Deps["sh"]): Promise<{ repo: string; root: string }> {
  const at = args.indexOf("--repo");
  const unknown = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (unknown.length > 0) throw new TargetError(`知らない引数: ${unknown.join(" ")}`);
  const originAt = async (root: string) => (await run(["git", "-C", root, "remote", "get-url", "origin"]).catch(() => "")).trim();
  if (at < 0) {
    const url = await originAt(scriptRoot);
    const repo = remoteRepo(url);
    if (!repo) throw new TargetError(`${scriptRoot} の origin（${url ? "GitHub の owner/name として読めない URL" : "無し"}）から対象が分からない（--repo <owner/name> を付ける）`);
    return { repo, root: scriptRoot };
  }
  const repo = args[at + 1] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new TargetError(`--repo は owner/name の形で: ${repo || "（空）"}`);
  const root = (await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => {
    throw new TargetError(`${cwd} は git の作業ツリーでない（${repo} の作業ツリーから実行する）`);
  })).trim();
  const url = await originAt(root);
  const origin = remoteRepo(url);
  if (origin?.toLowerCase() !== repo.toLowerCase()) {
    throw new TargetError(`${root} の origin（${origin ?? (url ? "GitHub の owner/name として読めない URL" : "無し")}）が --repo ${repo} と違う（${repo} の作業ツリーから実行する）`);
  }
  return { repo, root };
}

const sh: TagCiDeps["sh"] = async (cmd, cwd, input) => {
  const p = Bun.spawn(cmd, { cwd, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return out;
};

if (import.meta.main) {
  let t: { repo: string; root: string };
  let a: ReturnType<typeof parseArgs>;
  try {
    a = parseArgs(process.argv.slice(2));
    t = await resolveRepo(a.rest, process.cwd(), join(import.meta.dir, ".."), sh);
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
    console.error(`${e.message}\nusage: bun scripts/tag-ci.ts [--repo <owner/name>]\n       bun scripts/tag-ci.ts --latest-pass [--contained-in <commit>] [--repo <owner/name>]`);
    process.exit(2);
  }
  if (a.latestPass) {
    const tag = await latestPassTag(sh, t.repo, t.root, a.containedIn).catch((e: Error) => {
      console.error(e.message);
      process.exit(2);
    });
    if (tag) console.log(tag);
    process.exit(tag ? 0 : 1);
  }
  // stdout is the JSON only
  const entries = await tagCi({ sh, step, log: (l) => console.error(l) }, t.repo, t.root);
  console.log(JSON.stringify(entries));
  const log = (l: string) => console.error(l);
  try {
    // fileRequest's own output goes to stderr: stdout is the JSON only
    const file = (req: { title: string; body: string }) => fileRequest(req, { ...FILE_DEPS, out: (o) => process.stderr.write(o) });
    await followUp(entries, t.repo, t.root, !process.argv.includes("--repo"), { sh, log, file, comment: commentRequest, open: openRequests, text: requestText, print: log });
  } catch (e) {
    console.error(`要望: 起票かコメントができなかった（${(e as Error).message}）`);
  }
  process.exit(tagCiExit(entries));
}
