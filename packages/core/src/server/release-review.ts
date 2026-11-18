import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_REVIEW_ORIGIN, RELEASE_REVIEW_TITLE, releaseReviewOf, releaseReviewPrompt, type ReleaseReview } from "../release-review.ts";
import type { Task } from "@switchboard/protocol";
import type { ServerContext } from "./context.ts";

/**
 * The check of a public copy's new tag: under `<home>/release-review/<tag>/`, a detached tree of the tag
 * (`tree/`) and the diff from the running version (`diff.patch`), and a read-only Task in that folder (the prompt is this
 * version's own). The Task's cwd is the folder, not the tree: a runner reads its project settings (Claude Code's
 * `.claude/settings.json` hooks, Codex's `.codex/`) from its cwd, and the tag's own must not run. No shadow runner (a
 * second runner would start with its own permission mode). Null = started; else why it could not start.
 */
export const startReleaseReview = async (sc: Pick<ServerContext, "metaWorkspace" | "cfg" | "settings" | "adapterMap" | "autoRunner" | "removeReviewTree" | "askRescue" | "git" | "tasks" | "reviewedShaFile">, tag: string, sha: string, current: string, source?: string | null): Promise<string | null> => {
  const meta = sc.metaWorkspace();
  if (!meta) return `${tag} の差分を確認できない: meta workspace がありません`;
  const dir = join(sc.cfg.home, "release-review", tag);
  const tree = join(dir, "tree");
  const diffFile = join(dir, "diff.patch");
  try {
    const auto = sc.settings().autoStart;
    const configured = sc.adapterMap.has(auto.runner) ? auto.runner : sc.adapterMap.has("claude") ? "claude" : null;
    if (!configured) return `${tag} の差分を確認できない: ランナーが検出されていません`;
    const { runner, note } = sc.autoRunner(configured);
    const permissionMode = runner === "claude" ? "plan" : runner === "codex" ? "read-only" : null;
    if (!permissionMode) return `${tag} の差分を確認できない: ${runner} は読み取りだけの権限で動かせない`;
    // a new check starts from nothing: from a source this also drops a folder sb-rescue made for a commit the tag no longer names
    await sc.removeReviewTree(tag);
    let review = { tree, diffFile, stat: "" };
    if (source) {
      // an update source (no git): sb-rescue unpacks the tag's tarball and makes the diff against what runs. How long that may
      // take depends on the line and the tarball's size: SWITCHBOARD_RELEASE_TREE_TIMEOUT_MS (default 3 minutes)
      const r = await sc.askRescue("/api/release-tree", { method: "POST", body: JSON.stringify({ tag }), signal: AbortSignal.timeout(Number(process.env.SWITCHBOARD_RELEASE_TREE_TIMEOUT_MS) || 180_000) });
      const out = (await r.json().catch(() => ({}))) as { sha?: string; tree?: string; diffFile?: string; stat?: string[]; error?: string };
      if (!r.ok || !out.tree || !out.diffFile || !Array.isArray(out.stat)) throw new Error(`sb-rescue の release-tree が ${r.status}: ${out.error ?? "答えが読めない"}`);
      if (out.sha !== sha) throw new Error(`${tag} は ${sha} ではなく ${out.sha} を指している`);
      review = { tree: out.tree, diffFile: out.diffFile, stat: out.stat.join("\n") };
    } else {
      mkdirSync(dir, { recursive: true });
      await sc.git(["worktree", "add", "--detach", tree, sha]);
      await Bun.write(diffFile, await sc.git(["diff", `${current}..${sha}`]));
      review.stat = await sc.git(["diff", "--stat", `${current}..${sha}`]);
    }
    const model = note ? "" : runner === auto.runner ? auto.model : "";
    const effort = !note && runner === auto.runner && auto.effort && !sc.tasks.checkEffort(runner, auto.effort) ? auto.effort : "";
    sc.tasks.create({
      workspaceId: meta.id, cwd: dir, scope: [dir], runner, shadowRunner: null, title: `${RELEASE_REVIEW_TITLE} ${tag}`, origin: RELEASE_REVIEW_ORIGIN, permissionMode,
      prompt: releaseReviewPrompt({ from: current, to: sha, tag, ...review, runner }),
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    }, undefined, (t) => { if (note) sc.tasks.record(t.id, { t: "status", text: note }); });
    // from a source, the commit this check is for, kept after the check's folder goes: its result counts only for that
    // commit. Written once the check exists, so a start that failed leaves the previous check's commit in place
    if (source) {
      mkdirSync(join(sc.cfg.home, "release-review"), { recursive: true });
      writeFileSync(sc.reviewedShaFile(tag), sha + "\n");
    }
    return null;
  } catch (e) {
    await sc.removeReviewTree(tag);
    return `${tag} の差分の確認を始められなかった: ${String((e as Error).message ?? e)}`;
  }
};

/** From an update source: the commit the check of `tag` was made for (beside the folder, which goes when the check ends). */
export const reviewedShaFile = (sc: Pick<ServerContext, "cfg">, tag: string) => join(sc.cfg.home, "release-review", `${tag}.sha`);

export const reviewedSha = (sc: Pick<ServerContext, "reviewedShaFile">, tag: string): string | null => {
  try {
    return readFileSync(sc.reviewedShaFile(tag), "utf8").trim() || null;
  } catch {
    return null;
  }
};

export const removeReviewTree = async (sc: Pick<ServerContext, "cfg" | "git">, tag: string) => {
  const dir = join(sc.cfg.home, "release-review", tag);
  await sc.git(["worktree", "remove", "--force", join(dir, "tree")]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
};

// the check's turn ended (a finished Task keeps its session, so the turn end, not only the Task end): its tree and diff
// go, and the tag is asked about again. Read after the other turn-end listeners (the usage-limit one registers later and
// sets resumeAt): a check that will resume keeps its folder.
export const releaseReviewEnded = (sc: Pick<ServerContext, "db" | "removeReviewTree" | "metaWorkspace" | "promotionHold" | "askPromotion">, id: string, task: Task) => {
  if (task.origin !== RELEASE_REVIEW_ORIGIN) return;
  void Bun.sleep(0).then(() => {
    if (sc.db.getTask(id)?.resumeAt !== null) return;
    return sc.removeReviewTree(task.title.slice(RELEASE_REVIEW_TITLE.length + 1)).then(() => {
    if (!sc.metaWorkspace()) return;
      sc.promotionHold = null;
      return sc.askPromotion("idle");
    });
  }).catch(() => undefined);
};

export const releaseReviewFor = (sc: Pick<ServerContext, "db" | "reviewedSha">, r: { tag: string; sha: string }): ReleaseReview | null => {
  const t = sc.db.findTaskByOrigin(RELEASE_REVIEW_ORIGIN, `${RELEASE_REVIEW_TITLE} ${r.tag}`);
  const review = t ? releaseReviewOf(t, sc.db.lastReply(t.id)?.text ?? null, r) : null;
  // from an update source a tag can be moved: a check counts only for the commit it was made for (the file only that path
  // writes), so for the promotion, the screen and the re-check alike a moved tag reads as not checked
  const checked = sc.reviewedSha(r.tag);
  if (review && review.state !== "running" && checked !== null && checked !== r.sha) {
    return { ...review, state: "failed", findings: [], reason: `${r.tag} は確認した commit（${checked.slice(0, 7)}）ではなく ${r.sha.slice(0, 7)} を指している。確かめ直すまで上げない` };
  }
  return review;
};
