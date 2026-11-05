/**
 * The public sync standing still (#3601). The sync publishes only the newest tag that passed the tag CI
 * (`bun scripts/tag-ci.ts --latest-pass`), so a tag CI that keeps failing or never judges (recordings missing) stops the
 * public repository without anyone filing anything. tag-ci's scheduled run (Switchboard itself, no --repo) calls
 * stallFollow after its own report: when a tag newer than the newest pass has stood for more than STALL_HOURS, it files
 * one request (type:request, from a scheduled check) with the reasons it can read, or comments once a day on the open
 * one. When the public repository's newest Release is not the one the request read, it says so once per Release; it
 * never closes the request (the PBI that fixed it does). The stall is judged on the dev tags alone: the public
 * repository's tags are numbered on their own, so its newest tag says only whether something was published, not which.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSecrets, hostAws, type HostAws } from "../ops-kit/src/secrets.ts";
import { failedIn, hidePaths, tagResult, type FollowDeps } from "./tag-ci.ts";

/** The request's fixed title: an open one with it gets comments instead of a second request. */
export const STALL_TITLE = "要望: 公開の同期が進んでいない";
/** How long a tag newer than the newest pass may stand before it is a stall. */
export const STALL_HOURS = 24;
/** The tags read back for the newest pass (the walk stops at it). */
const MAX_TAGS = 50;

/**
 * A tag, as stallFollow reads it: `at` = the tag's date (ms; for a lightweight tag, which release-tag.ts makes, its
 * commit's committer date, so the 24 hours can start a little before the tag was pushed), its tag-CI result, and why
 * there is no pass.
 */
export interface StallTag { tag: string; at: number; result: "pass" | "fail" | null; reason?: string }

export type Stall =
  | { stalled: false; lastPass: string | null }
  | { stalled: true; since: number; lastPass: StallTag | null; newer: StallTag[]; publicLatest: { tag: string; at: string } | null };

/**
 * `tags` newest first. The newest pass P is what the sync can publish; the tags newer than P wait for it. A stall is
 * the oldest of them standing for more than `hours`. No pass at all: every tag read waits.
 */
export function judgeStall(s: { now: number; tags: StallTag[]; publicLatest: { tag: string; at: string } | null }, hours = STALL_HOURS): Stall {
  const at = s.tags.findIndex((t) => t.result === "pass");
  const lastPass = at < 0 ? null : s.tags[at]!;
  const newer = at < 0 ? s.tags : s.tags.slice(0, at);
  const oldest = newer.at(-1);
  if (!oldest || s.now - oldest.at <= hours * 3600_000) return { stalled: false, lastPass: lastPass?.tag ?? null };
  return { stalled: true, since: oldest.at, lastPass, newer, publicLatest: s.publicLatest };
}

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

/** The line that names the newest pass in the request's body. */
export const LAST_PASS_LINE = "タグの CI を通った最新のタグ: ";
/** The line that names the public repository's newest Release: stallFollow reads it back to tell the public sync moved on. */
export const PUBLIC_LINE = "公開側の最新のタグ: ";

/** The reason lines: what the sync is waiting on. No host paths; with a value usable for auth, a note instead. */
export function stallDetail(j: Extract<Stall, { stalled: true }>, host: HostAws = hostAws()): string[] {
  // tag names and their times hold no secret: these lines stay, and the public one is read back to tell a publication
  const last = `${LAST_PASS_LINE}${j.lastPass ? `${j.lastPass.tag}（${when(j.lastPass.at)}）` : "なし（読んだタグに pass が無い）"}`;
  const pub = `${PUBLIC_LINE}${j.publicLatest ? `${j.publicLatest.tag}（${j.publicLatest.at}）` : "読めなかった"}`;
  const detail = [
    "それより新しいタグ（新しい順）:",
    ...j.newer.map((t) => `  ${t.tag}（${when(t.at)}）: ${t.result === "fail" ? "fail" : "判定なし"}${t.reason ? `（${hidePaths(t.reason)}）` : ""}`),
  ];
  return [last, ...(findSecrets(detail.join("\n"), host).length === 0 ? detail : ["（タグの理由に認証に使える値が含まれるので書かない。各タグの Release の `## CI` を見る）"]), pub];
}

/** The reason of a tag tag-ci did not judge for its recordings: runTag gives a note in （） when the list itself could not be read. */
export const skipReason = (missing: string[]): string => (missing[0]?.startsWith("（") ? missing.join(" ") : `録画が足りない: ${missing.join(" ")}`);

/** The request for a stall: the title is fixed, the body has what the sync is waiting on. */
export function stallRequest(j: Extract<Stall, { stalled: true }>, date = new Date().toISOString().slice(0, 10), host: HostAws = hostAws(), hours = STALL_HOURS): { title: string; body: string } {
  const body = [
    "## 要望",
    `公開の同期が ${hours} 時間を超えて進んでいない（${when(j.since)} に付いたタグから）。止まっている理由を直してほしい（この要望は直した PBI が閉じる）。`,
    "",
    "````text",
    ...stallDetail(j, host),
    "````",
    "",
    "公開の同期はタグの CI を通った最新のタグ（`bun scripts/tag-ci.ts --latest-pass`）だけを公開する。それより新しいタグの結果は各タグの Release の `## CI`（`gh release view <タグ> --json body -q .body`）。判定なしは、タグの CI がまだ回していないか、録画が足りないなどで判定せず印を付けなかったタグ。",
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `- いつ: ${date}`,
    "- 経路: 公開の同期の見張り（scripts/public-stall.ts）",
    "",
    "## 添付",
    "なし",
    "",
    "## 派生 PBI",
    "",
    "## 解釈メモ",
    "- 題は固定。止まりが続けば 1 日 1 回この要望に今の理由のコメントが付き、公開側の最新の Release がこの要望の読んだものから変われば「公開が進んだ: <公開側のタグ>」とコメントが付く（閉じない）",
  ].join("\n");
  return { title: STALL_TITLE, body };
}

/** The `vX.Y.Z` tags of the clone at `root`, newest first, read back to the newest pass (at most MAX_TAGS). `skipped`: tags this run did not judge, and why. */
export async function readStallTags(root: string, repo: string, sh: FollowDeps["sh"], skipped: Record<string, string> = {}): Promise<StallTag[]> {
  const fmt = "%(refname:short)\t%(creatordate:unix)\t%(objectname)\t%(*objectname)";
  const lines = (await sh(["git", "-C", root, "for-each-ref", "--sort=-v:refname", `--format=${fmt}`, "refs/tags/v*"])).split("\n");
  const out: StallTag[] = [];
  for (const line of lines) {
    const [tag, unix, object, peeled] = line.split("\t");
    if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    const sha = peeled || object!;
    const body = await sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    const result = body === null ? null : tagResult(body, sha);
    const reason = body === null
      ? "Release が無いか読めない"
      : result === "fail"
        ? (() => { const f = failedIn(body); return f ? `\`${f.step}\` が落ちた` : undefined; })()
        : result === null ? (skipped[tag] ?? "Release に [tag-ci] の印が無い") : undefined;
    out.push({ tag, at: Number(unix) * 1000, result, ...(reason ? { reason } : {}) });
    if (result === "pass" || out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The public repository of ops.config.json's publicSync, or null. */
export function publicTarget(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, "ops.config.json"), "utf8")) as { publicSync?: { target?: string } }).publicSync?.target ?? null;
  } catch {
    return null;
  }
}

/** The public repository's newest Release, or null when it cannot be read (the body says so). */
async function readPublicLatest(target: string | null, sh: FollowDeps["sh"]): Promise<{ tag: string; at: string } | null> {
  if (!target) return null;
  const out = await sh(["gh", "release", "view", "-R", target, "--json", "tagName,publishedAt", "-q", '"\\(.tagName) \\(.publishedAt)"']).catch(() => null);
  const [tag, at] = (out ?? "").trim().split(" ");
  return tag && at ? { tag, at } : null;
}

/**
 * See the file's comment. Says only what the open request does not say yet: one comment a day while it stands still,
 * one `公開が進んだ: <tag>` per new newest pass.
 */
export async function stallFollow(
  repo: string,
  root: string,
  d: FollowDeps,
  o: { target: string | null; skipped?: Record<string, string>; now?: number; date?: string; host?: HostAws; hours?: number },
): Promise<void> {
  const now = o.now ?? Date.now();
  const date = o.date ?? new Date(now).toISOString().slice(0, 10);
  const tags = await readStallTags(root, repo, d.sh, o.skipped);
  const j = judgeStall({ now, tags, publicLatest: null }, o.hours ?? STALL_HOURS);
  const open = (await d.open()).find((r) => r.title === STALL_TITLE)?.ref ?? null;
  if (open === null && !j.stalled) return;
  const publicLatest = await readPublicLatest(o.target, d.sh);
  // a publication: the public repository's newest Release is not the first one the request read (its body, or a later
  // comment when the body could not read it). Said once per Release, whether or not a newer tag still stands. Nothing
  // read before: the one read now is written down to compare with (a publication before it is not told)
  if (open !== null && publicLatest !== null) {
    const said = (await d.text(open)).split("\n");
    const named = said.map((l) => l.trim()).find((l) => l.startsWith(PUBLIC_LINE) && !l.endsWith("読めなかった"))?.slice(PUBLIC_LINE.length).split("（")[0];
    const line = `公開が進んだ: ${publicLatest.tag}`;
    if (named === undefined) {
      await d.comment(open, `${PUBLIC_LINE}${publicLatest.tag}（${publicLatest.at}。要望を立てたときは読めなかった。この後の公開をこれと比べる）`);
      d.log(`要望 ${open}: 公開側の最新のタグを書いた`);
    } else if (named !== publicLatest.tag && !said.some((l) => l.trim().startsWith(`${line}（`))) {
      const pass = j.stalled ? j.lastPass?.tag : j.lastPass;
      await d.comment(open, `${line}（${publicLatest.at}${pass ? `、タグの CI を通った最新のタグ ${pass}` : ""}）`);
      d.log(`要望 ${open}: ${line}とコメントした`);
    }
  }
  if (!j.stalled) return;
  const stall = { ...j, publicLatest };
  let ref = open;
  if (ref === null) {
    const r = await d.file(stallRequest(stall, date, o.host, o.hours));
    if (!("open" in r)) {
      d.log(`公開の同期が止まっている: 要望を立てた（${r.filed === null ? "番号不明" : `#${r.filed}`}）`);
      return;
    }
    ref = r.open;
  }
  // one comment a day: the day it was filed has its body
  const head = `${date} の見張り: まだ進んでいない`;
  const text = await d.text(ref);
  if (text.includes(head) || text.includes(`- いつ: ${date}`)) return;
  await d.comment(ref, [head, "", "````text", ...stallDetail(stall, o.host), "````"].join("\n"));
  d.log(`公開の同期が止まっている: 既存 ${ref} にコメントした`);
}
