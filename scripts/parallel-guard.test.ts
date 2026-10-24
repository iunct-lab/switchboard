import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appBoard, claim, commentId, ghBoard, ghMaterial, holder, judge, lastClaim, overlap, pathsIn, readOthers, release, releaseArgs, releaseBody, STALE_HOURS, storedMaterial, type Work } from "./parallel-guard";
import type { StoredRecords } from "../ops-kit/src/backlog-client";

const REPO = "example/development";
const now = new Date("2026-09-28T12:00:00Z");
const fresh = "2026-09-28T11:00:00Z";
const old = new Date(now.getTime() - (STALE_HOURS + 1) * 3600_000).toISOString();
const top = [
  { name: "packages", dir: true }, { name: "apps", dir: true }, { name: "aws", dir: true }, { name: "docs", dir: true },
  { name: "package.json", dir: false }, { name: "README.md", dir: false },
];

describe("parallel-guard holder", () => {
  const c = (id: number, kind: string, token = `t${id}`) => ({ id, body: `<!-- pbi-complete:${kind} ${token} -->\n本文` });

  test("no claim comment means nobody holds the PBI", () => {
    expect(holder([{ id: 1, body: "着手します" }])).toBeNull();
  });

  test("the first claim wins even when the comments come back out of order", () => {
    expect(holder([c(12, "claim"), c(10, "claim")])).toEqual({ id: 10, token: "t10" });
  });

  test("a release clears the holder and the next claim holds it", () => {
    expect(holder([c(1, "claim"), { id: 2, body: "<!-- pbi-complete:release -->" }])).toBeNull();
    expect(holder([c(1, "claim"), { id: 2, body: "<!-- pbi-complete:release -->" }, c(3, "claim")])).toEqual({ id: 3, token: "t3" });
  });

  test("a takeover replaces a holder that is still there", () => {
    expect(holder([c(1, "claim"), c(2, "takeover")])).toEqual({ id: 2, token: "t2" });
  });
});

describe("parallel-guard pathsIn", () => {
  test("reads paths under the root's directories and the root's files; drops the line number and a trailing period", () => {
    const body = "触る: `packages/core/src/db.ts:120`、apps/web/src/App.tsx。docs/design/ 以下、aws/template.yaml、`package.json`、README.md";
    expect(pathsIn(body, top)).toEqual([
      "packages/core/src/db.ts", "apps/web/src/App.tsx", "docs/design/", "aws/template.yaml", "package.json", "README.md",
    ]);
  });

  test("a root file name inside another path or word is not the root file", () => {
    expect(pathsIn("docs/README.md と apps/web/package.json、mypackage.json、package.json5", top)).toEqual(["docs/README.md", "apps/web/package.json"]);
  });
});

test("parallel-guard pathsIn: a backticked path counts even when no branch has it yet", () => {
  expect(pathsIn("`new-config.json:10-20`、`tools/gen.ts:3`、`gh stack add`、`readOthers`、`Bun.serve`、`.env`、`turn/completed`、`origin/main`、`@switchboard/protocol`", top)).toEqual(["new-config.json", "tools/gen.ts"]);
});

describe("parallel-guard judge", () => {
  const pr = (paths: string[], updatedAt = fresh): Work => ({ ref: "PR #9", paths, updatedAt });
  const task = (n: number, paths: string[], claimId?: number): Work => ({ ref: `Task #${n}`, task: n, paths, updatedAt: fresh, claimId });
  const db = ["packages/core/src/db.ts"];

  test("no shared file goes", () => {
    expect(judge({ paths: db }, [pr(["apps/web/src/App.tsx"])], now)).toEqual({ verdict: "go", blocking: [], stale: [] });
  });

  test("an open PR on the same file defers, before and after claiming", () => {
    const v = judge({ paths: db }, [pr(db)], now);
    expect(v.verdict).toBe("defer");
    expect(v.blocking).toEqual([{ ref: "PR #9", path: "packages/core/src/db.ts", updatedAt: fresh }]);
    expect(judge({ paths: db, claimId: 5 }, [pr(db)], now).verdict).toBe("defer");
  });

  test("a directory named by another Task covers the files under it", () => {
    expect(judge({ paths: ["docs/design/x.md"] }, [task(40, ["docs/design/"])], now).verdict).toBe("defer");
  });

  test("work untouched for longer than the stale limit is reported but does not block", () => {
    const v = judge({ paths: db }, [pr(db, old)], now);
    expect(v.verdict).toBe("go");
    expect(v.stale).toHaveLength(1);
  });

  test("after claiming, only a Task that claimed first blocks; one that has not claimed yet will yield itself", () => {
    expect(judge({ paths: db }, [task(60, db)], now).verdict).toBe("defer");
    expect(judge({ paths: db, claimId: 100 }, [task(60, db, 90)], now).verdict).toBe("defer");
    expect(judge({ paths: db, claimId: 100 }, [task(40, db, 110)], now).verdict).toBe("go");
    expect(judge({ paths: db, claimId: 100 }, [task(40, db)], now).verdict).toBe("go");
  });

  test("the last claim of a Task counts", () => {
    expect(lastClaim([{ id: 3, body: "<!-- parallel-guard:task-claim -->\nx" }, { id: 9, body: "<!-- parallel-guard:task-claim -->" }, { id: 12, body: "他" }])).toBe(9);
    expect(lastClaim([{ id: 3, body: "他" }])).toBeUndefined();
  });
});

// A fake GitHub: comments per issue with growing ids, the open Tasks with their Project Status, the PR list. `beforePost` runs just before a comment
// lands, as a racing session would.
function github(opts: {
  bodies: Record<number, string>;
  parents?: Record<number, { number: number; subs: number[]; body?: string }>;
  targets?: Record<number, { state: "open" | "closed"; state_reason?: string; pr?: boolean; merged?: boolean }>; // the Issues / PRs named as prerequisites; others 404
  inProgress?: number[];
  projects?: Record<number, { number: number; owner: { login: string }; status: string }[]>; // other Projects a Task is in, listed first
  prs?: { number: number; headRefName: string; body: string; files: string[]; isDraft?: boolean; labels?: { name: string }[] }[];
  decisionTasks?: number[];
  comments?: Record<number, { id: number; body: string }[]>;
  beforePost?: (issue: number) => void;
}) {
  const comments: Record<number, { id: number; body: string }[]> = opts.comments ?? {};
  let next = Math.max(99, ...Object.values(comments).flat().map((c) => c.id)) + 1;
  const calls: string[][] = [];
  const add = (issue: number, body: string) => {
    const c = { id: next++, body };
    (comments[issue] ??= []).push(c);
    return c;
  };
  const run = async (args: string[]) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (args.includes("POST")) {
      const issue = Number(/issues\/(\d+)\/comments/.exec(path)![1]);
      opts.beforePost?.(issue);
      return JSON.stringify(add(issue, args[args.length - 1].slice("body=".length)));
    }
    if (args.includes("DELETE")) {
      const id = Number(path.split("/").pop());
      for (const list of Object.values(comments)) {
        const i = list.findIndex((c) => c.id === id);
        if (i >= 0) list.splice(i, 1);
      }
      return "";
    }
    if (path.endsWith("/contents")) return top.map((t) => JSON.stringify(t)).join("\n");
    const m = /issues\/(\d+)\/comments/.exec(path);
    if (m) return (comments[Number(m[1])] ?? []).map((c) => JSON.stringify(c)).join("\n");
    if (args[0] === "variable") return "https://github.com/orgs/example/projects/8\n";
    if (args[1] === "graphql" && args.some((a) => a.includes("issues("))) {
      return Object.entries(opts.bodies).map(([n, body]) => JSON.stringify({
        number: Number(n), body, updatedAt: fresh, labels: { nodes: opts.decisionTasks?.includes(Number(n)) ? [{ name: "needs-decision" }] : [] },
        projectItems: { nodes: [
          ...(opts.projects?.[Number(n)] ?? []).map(({ status, ...project }) => ({ project, fieldValueByName: { name: status } })),
          { project: { number: 8, owner: { login: "example" } }, fieldValueByName: { name: opts.inProgress?.includes(Number(n)) ? "In progress" : "Backlog" } },
        ] },
      })).join("\n");
    }
    if (args[1] === "graphql") {
      const n = Number(args[args.length - 1].slice(2));
      const p = opts.parents?.[n];
      return JSON.stringify({ data: { repository: { issue: {
        body: opts.bodies[n] ?? "",
        parent: p ? { number: p.number, body: p.body ?? "", subIssues: { nodes: p.subs.map((number) => ({ number })) } } : null,
      } } } });
    }
    const target = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
    if (target) {
      const t = opts.targets?.[Number(target[1])];
      if (!t) throw new Error("gh api repos/… failed: gh: Not Found (HTTP 404)");
      return JSON.stringify({ state: t.state, state_reason: t.state_reason ?? null, merged: !!t.merged, pr: !!t.pr });
    }
    if (args[0] === "pr") return JSON.stringify((opts.prs ?? []).map((p) => ({ isDraft: false, labels: [], ...p, updatedAt: fresh, files: p.files.map((path) => ({ path })) })));
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { run, comments, calls, add };
}

describe("parallel-guard claim", () => {
  test("an unclaimed PBI is claimed, and the comment names no host", async () => {
    const g = github({ bodies: {} });
    expect((await claim(ghBoard(REPO, g.run), 7, false)).held).toBe(true);
    expect(g.comments[7]).toHaveLength(1);
    expect(g.comments[7]![0]!.body).toContain("worktree: ../switchboard-pbi7");
    expect(g.comments[7]![0]!.body).not.toContain(require("node:os").hostname());
  });

  test("a held PBI is not claimed and nothing is posted", async () => {
    const g = github({ bodies: {}, comments: { 7: [{ id: 5, body: "<!-- pbi-complete:claim other -->" }] } });
    expect(await claim(ghBoard(REPO, g.run), 7, false)).toEqual({ held: false, holder: { id: 5, token: "other" } });
    expect(g.calls.some((a) => a.includes("POST"))).toBe(false);
  });

  test("losing a race withdraws the claim comment", async () => {
    let raced = false;
    const g = github({ bodies: {}, beforePost: (i) => { if (!raced) { raced = true; g.add(i, "<!-- pbi-complete:claim rival -->"); } } });
    expect(await claim(ghBoard(REPO, g.run), 7, false)).toEqual({ held: false, holder: { id: 100, token: "rival" } });
    expect(g.comments[7]!.map((c) => c.id)).toEqual([100]);
  });

  test("a takeover holds a PBI another session still claims", async () => {
    const g = github({ bodies: {}, comments: { 7: [{ id: 5, body: "<!-- pbi-complete:claim dead -->" }] } });
    expect((await claim(ghBoard(REPO, g.run), 7, true)).held).toBe(true);
  });

  test("another repository's PBI is claimed in that repository", async () => {
    const g = github({ bodies: {} });
    await claim(ghBoard("acme/lib", g.run), 7, false);
    expect(g.calls.filter((a) => a.includes("POST"))[0]).toContain("repos/acme/lib/issues/7/comments");
  });
});

describe("parallel-guard waits", () => {
  test("overlap waits are explicit and still release the holder", async () => {
    const body = releaseBody("重複", [52], true);
    expect(body).toContain("release overlap=52");
    expect(holder([{ id: 1, body: "<!-- pbi-complete:claim t -->" }, { id: 2, body }])).toBeNull();
    expect(releaseArgs(["重複", "--overlap-waits", "52"])).toEqual({ reason: "重複", waits: [52], overlap: true });
    for (const words of [["重複", "--overlap-waits", "52", "--waits", "53"], ["重複", "--overlap-waits", "x"], ["重複", "--overlap-waits", "52", "--overlap-waits", "53"]]) expect(releaseArgs(words)).toBeNull();
    const g = github({ bodies: {} }); await release(ghBoard(REPO, g.run), 7, "重複", [52], true);
    expect(g.comments[7]![0]!.body).toContain("release overlap=52");
  });

  test("the release marker lists the waits sorted and without duplicates", () => {
    expect(releaseBody("後回し: #9", [778, 603, 778]).split("\n")[0]).toBe("<!-- pbi-complete:release waits=603,778 -->");
  });

  test("a release without waits keeps its body", () => {
    expect(releaseBody("完了")).toBe("<!-- pbi-complete:release -->\n/pbi-complete 終了: 完了");
  });

  test("a release with waits still clears the holder", () => {
    expect(holder([{ id: 1, body: "<!-- pbi-complete:claim t1 -->" }, { id: 2, body: releaseBody("後回し", [603]) }])).toBeNull();
  });

  test("the CLI's release words split into the reason and the waits", () => {
    expect(releaseArgs(["後回し:", "#9", "--waits", "778,603"])).toEqual({ reason: "後回し: #9", waits: [778, 603] });
    expect(releaseArgs(["--waits", "449", "後回し"])).toEqual({ reason: "後回し", waits: [449] });
    expect(releaseArgs(["完了"])).toEqual({ reason: "完了", waits: [] });
    for (const bad of [["x", "--waits", "1,a"], ["x", "--waits", "0"], ["x", "--waits", "012"], ["x", "--waits"], ["--waits", "1"], ["x", "--waits", "1", "--waits", "2"]]) {
      expect(releaseArgs(bad)).toBeNull();
    }
  });

  test("release posts the waits", async () => {
    const g = github({ bodies: {} });
    await release(ghBoard(REPO, g.run), 7, "後回し: #9（PR #449 と重なる）", [449]);
    expect(g.comments[7]![0]!.body).toContain("waits=449");
  });
});

describe("parallel-guard readOthers", () => {
  test("an active Draft holds its actual changed files even beyond its Task's named paths", async () => {
    const g = github({ bodies: { 11: "packages/core/src/db.ts", 52: "packages/core/src/config.ts" }, inProgress: [52],
      prs: [{ number: 49, headRefName: "sb/52-binary", body: "Closes #52", files: ["packages/core/src/db.ts"], isDraft: true }] });
    expect((await overlap(ghBoard(REPO, g.run), 11, false, now)).blocking.map((h) => h.ref)).toEqual(["PR #49"]);
  });

  test("deferred Draft and decision PRs do not reserve files, but a live Task on a Draft still does", async () => {
    const make = (active: boolean) => github({
      bodies: { 11: "packages/core/src/config.ts", 52: "packages/core/src/config.ts" },
      inProgress: active ? [52] : [],
      prs: [
        { number: 49, headRefName: "sb/52-binary", body: "Closes #52", files: ["packages/core/src/config.ts"], isDraft: true },
        { number: 50, headRefName: "feat/deferred", body: "", files: ["packages/core/src/config.ts"], labels: [{ name: "needs-decision" }] },
      ],
    });
    expect((await overlap(ghBoard(REPO, make(false).run), 11, false, now)).verdict).toBe("go");
    expect((await overlap(ghBoard(REPO, make(true).run), 11, false, now)).blocking.map((h) => h.ref)).toEqual(["PR #49", "Task #52"]);
  });

  test("decision Tasks do not reserve files; resuming the Task or readying the PR restores protection", async () => {
    const make = (deferred: boolean) => github({
      bodies: { 11: "packages/core/src/config.ts", 52: "packages/core/src/config.ts" },
      inProgress: [52], decisionTasks: deferred ? [52] : [],
      prs: [{ number: 49, headRefName: "sb/52-binary", body: "", files: ["packages/core/src/config.ts"], isDraft: deferred }],
    });
    expect((await overlap(ghBoard(REPO, make(true).run), 11, false, now)).verdict).toBe("go");
    expect((await overlap(ghBoard(REPO, make(false).run), 11, false, now)).blocking.map((h) => h.ref)).toEqual(["PR #49", "Task #52"]);
  });

  test("leaves out the Task's own PBI (its Tasks and their PRs) and Tasks that are not In progress", async () => {
    const g = github({
      bodies: { 11: "触る: `packages/core/src/db.ts`", 12: "packages/core/src/db.ts", 30: "`apps/web/src/App.tsx`", 31: "packages/core/src/db.ts" },
      parents: { 11: { number: 10, subs: [11, 12] } },
      inProgress: [12, 30],
      prs: [
        { number: 70, headRefName: "sb/12-x", body: "", files: ["packages/core/src/db.ts"] },
        { number: 71, headRefName: "feat/y", body: "Closes #11", files: ["packages/core/src/db.ts"] },
        { number: 72, headRefName: "sb/40-z", body: "Closes #40", files: ["packages/core/src/server.ts"] },
      ],
    });
    const r = await readOthers(11, await ghMaterial(REPO, 11, g.run));
    expect(r.paths).toEqual(["packages/core/src/db.ts"]);
    expect(r.others.map((w) => w.ref)).toEqual(["PR #72", "Task #30"]);
  });

  // Codex's follow-up on #485: a root file only an open PR adds is not in the repository's root yet
  test("a new root file or directory an open PR adds is a path in the Task too", async () => {
    const g = github({
      bodies: { 11: "new-config.json と tools/gen.ts を足す。packages/core/src/db.ts" },
      prs: [{ number: 80, headRefName: "feat/cfg", body: "", files: ["new-config.json", "tools/gen.ts"] }],
    });
    const r = await readOthers(11, await ghMaterial(REPO, 11, g.run));
    expect(r.paths.sort()).toEqual(["new-config.json", "packages/core/src/db.ts", "tools/gen.ts"]);
    expect(judge({ paths: r.paths }, r.others, now).blocking.map((h) => h.path).sort()).toEqual(["new-config.json", "tools/gen.ts"]);
  });
});

describe("parallel-guard overlap", () => {
  test("current Draft files participate symmetrically even beyond the Task's declared paths", async () => {
    const g = github({ bodies: { 40: "packages/a.ts", 60: "packages/shared.ts" }, inProgress: [40, 60],
      prs: [{ number: 140, headRefName: "sb/40-draft", body: "Closes #40", files: ["packages/shared.ts"], isDraft: true }] });
    expect((await overlap(ghBoard(REPO, g.run), 60, true, now)).verdict).toBe("go");
    const second = await overlap(ghBoard(REPO, g.run), 40, true, now);
    expect(second.paths).toContain("packages/shared.ts");
    expect(second.verdict).toBe("defer");
    expect(g.comments[40] ?? []).toHaveLength(0);
  });

  test("two active Drafts retain Task claim ordering when resuming together", async () => {
    const g = github({ bodies: { 40: "packages/core/src/db.ts", 60: "packages/core/src/db.ts" },
      prs: [40, 60].map((n) => ({ number: 100 + n, headRefName: `sb/${n}-draft`, body: `Closes #${n}`, files: ["packages/core/src/db.ts"], isDraft: true })) });
    expect((await overlap(ghBoard(REPO, g.run), 40, false, now)).verdict).toBe("go");
    expect((await overlap(ghBoard(REPO, g.run), 60, false, now)).verdict).toBe("go");
    const live = github({ bodies: { 40: "packages/core/src/db.ts", 60: "packages/core/src/db.ts" }, inProgress: [40, 60], comments: g.comments,
      prs: [40, 60].map((n) => ({ number: 100 + n, headRefName: `sb/${n}-draft`, body: `Closes #${n}`, files: ["packages/core/src/db.ts"], isDraft: true })) });
    expect((await overlap(ghBoard(REPO, live.run), 60, true, now)).verdict).toBe("go");
    expect((await overlap(ghBoard(REPO, live.run), 40, true, now)).verdict).toBe("defer");
    expect(live.comments[40] ?? []).toHaveLength(0);
  });

  const db = "`packages/core/src/db.ts`";

  // Codex's case on #485: #40 and #60 both pass the check before either is In progress; #60 claims and rechecks first,
  // then #40 claims. #40 must not go on just because its number is smaller.
  test("of two staggered starts on the same file only the first claim goes on", async () => {
    const g = github({ bodies: { 40: db, 60: db } });
    expect((await overlap(ghBoard(REPO, g.run), 60, false, now)).verdict).toBe("go"); // both checks pass: nothing In progress yet
    expect((await overlap(ghBoard(REPO, g.run), 40, false, now)).verdict).toBe("go");
    const g2 = github({ bodies: { 40: db, 60: db }, inProgress: [60] });
    expect((await overlap(ghBoard(REPO, g2.run), 60, true, now)).verdict).toBe("go"); // #40 not In progress yet
    const g3 = github({ bodies: { 40: db, 60: db }, inProgress: [40, 60], comments: g2.comments });
    const late = await overlap(ghBoard(REPO, g3.run), 40, true, now);
    expect(late.verdict).toBe("defer");
    expect(late.blocking.map((h) => h.ref)).toEqual(["Task #60"]);
    expect(g3.comments[40] ?? []).toHaveLength(0); // the yielding Task withdraws its claim
    expect(g3.comments[60]).toHaveLength(1);
  });

  test("claiming at the same time: the later claim yields, the earlier one goes on", async () => {
    const g = github({ bodies: { 40: db, 60: db }, inProgress: [40, 60] });
    const first = await overlap(ghBoard(REPO, g.run), 60, true, now); // claims 100; #40 has no claim yet → #40 will yield
    expect(first.verdict).toBe("go");
    expect((await overlap(ghBoard(REPO, g.run), 40, true, now)).verdict).toBe("defer");
  });

  test("a Task with no named path cannot be judged and leaves no claim behind", async () => {
    const g = github({ bodies: { 40: "適切な場所に" }, inProgress: [40] });
    await expect(overlap(ghBoard(REPO, g.run), 40, true, now)).rejects.toThrow("パスが無い");
    expect(g.comments[40] ?? []).toHaveLength(0);
  });

  test("reads the In progress Tasks without the Project's item list", async () => {
    const g = github({ bodies: { 40: db, 60: db }, inProgress: [60] });
    expect((await overlap(ghBoard(REPO, g.run), 40, false, now)).blocking.map((h) => h.ref)).toEqual(["Task #60"]);
    expect(g.calls.some((a) => a[0] === "project")).toBe(false);
  });

  test("only the status on the repository's Project counts, not another Project's of the same number", async () => {
    const elsewhere = (status: string) => [{ number: 3, owner: { login: "iunct-lab" }, status }, { number: 2, owner: { login: "someone" }, status }];
    const g = github({ bodies: { 40: db, 60: db }, inProgress: [60], projects: { 60: elsewhere("Backlog") } });
    expect((await overlap(ghBoard(REPO, g.run), 40, false, now)).blocking.map((h) => h.ref)).toEqual(["Task #60"]);
    const g2 = github({ bodies: { 40: db, 60: db }, projects: { 60: elsewhere("In progress") } });
    expect((await overlap(ghBoard(REPO, g2.run), 40, false, now)).verdict).toBe("go");
  });
});

describe("parallel-guard prereqs (#937)", () => {
  const db = "`packages/core/src/db.ts`";
  const task = (prereq: string, more: Partial<Parameters<typeof github>[0]> = {}) =>
    github({ bodies: { 52: `${db}\n\n${prereq}` }, parents: { 52: { number: 50, subs: [52, 53] } }, ...more });

  test("another PBI's open Task waits; the same PBI's open Task is the stack's order and goes", async () => {
    const other = await overlap(ghBoard(REPO, task("**前提**: #61", { targets: { 61: { state: "open" } } }).run), 52, false, now);
    expect(other).toMatchObject({ verdict: "wait", prereqs: [{ ref: "#61", state: "pending", sibling: false }] });
    const sibling = await overlap(ghBoard(REPO, task("**前提**: #53", { targets: { 53: { state: "open" } } }).run), 52, false, now);
    expect(sibling).toMatchObject({ verdict: "go", prereqs: [{ ref: "#53", state: "pending", sibling: true }] });
    const done = await overlap(ghBoard(REPO, task("**前提**: #61", { targets: { 61: { state: "closed", state_reason: "completed" } } }).run), 52, false, now);
    expect(done).toMatchObject({ verdict: "go", prereqs: [{ ref: "#61", state: "met" }] });
  });

  test("a PR closed unmerged, a 404, a closed-as-not-planned Issue or a release stop", async () => {
    const cases: Array<[string, Parameters<typeof github>[0]["targets"], string, string]> = [
      ["**前提**: #70", { 70: { state: "closed", pr: true, merged: false } }, "PR #70", "withdrawn"],
      ["**前提**: #99", {}, "#99", "missing"],
      ["**前提**: #61", { 61: { state: "closed", state_reason: "not_planned" } }, "#61", "withdrawn"],
      ["**前提**: #70（リリース）", { 70: { state: "closed", pr: true, merged: false } }, "PR #70", "withdrawn"],
      ["**前提**: #71（リリース）", { 71: { state: "closed" } }, "#71", "unknown"], // an Issue is never released
    ];
    for (const [line, targets, ref, state] of cases) expect(await overlap(ghBoard(REPO, task(line, { targets }).run), 52, false, now)).toMatchObject({ verdict: "stop", prereqs: [{ ref, state }] });
  });

  test("a merged （リリース） prerequisite goes: whether it runs is the daemon's to judge before it starts the PBI", async () => {
    expect(await overlap(ghBoard(REPO, task("**前提**: #70（リリース）", { targets: { 70: { state: "closed", pr: true, merged: true } } }).run), 52, false, now)).toMatchObject({ verdict: "go", prereqs: [{ ref: "PR #70", state: "met" }] });
    expect(await overlap(ghBoard(REPO, task("**前提**: #70（リリース）", { targets: { 70: { state: "open", pr: true } } }).run), 52, false, now)).toMatchObject({ verdict: "wait" });
  });

  test("the PBI's own prerequisites count; free text does not; with none the output is as before", async () => {
    const g = github({ bodies: { 52: `${db}\n前提: #61 が Done` }, parents: { 52: { number: 50, subs: [52], body: "**前提**: #62" } }, targets: { 61: { state: "open" }, 62: { state: "open", pr: true } } });
    expect(await overlap(ghBoard(REPO, g.run), 52, false, now)).toMatchObject({ verdict: "wait", prereqs: [{ ref: "PR #62", state: "pending", sibling: false }] });
    const none = await overlap(ghBoard(REPO, task("**前提**: なし").run), 52, false, now);
    expect(none).toEqual({ paths: ["packages/core/src/db.ts"], verdict: "go", blocking: [], stale: [] });
  });

  test("a Task that has to wait withdraws its claim", async () => {
    const g = task("**前提**: #61", { targets: { 61: { state: "open" } }, inProgress: [52] });
    expect((await overlap(ghBoard(REPO, g.run), 52, true, now)).verdict).toBe("wait");
    expect(g.comments[52] ?? []).toHaveLength(0);
  });
});

describe("parallel-guard from the app's stored records (#919)", () => {
  const db = "`packages/core/src/db.ts`";
  const issue = (n: number, over: Partial<StoredRecords["issues"][number]> = {}): StoredRecords["issues"][number] => ({ number: n, title: "", state: "OPEN", stateReason: null, body: "", labels: ["type:task"], parent: null, subIssues: [], updatedAt: fresh, fields: null, ...over });
  const pull = (n: number, closes: number[], files: string[] | null, over: Partial<StoredRecords["pulls"][number]> = {}): StoredRecords["pulls"][number] => ({ number: n, state: "OPEN", isDraft: false, labels: [], closes, mergeCommit: null, updatedAt: fresh, files, ...over });
  const records = (issues: StoredRecords["issues"], pulls: StoredRecords["pulls"] = [], unread: number[] = []): StoredRecords => ({ workspaceId: "w", service: "github", repository: REPO, project: { owner: "example", number: 8 }, fetchedAt: 1, top: [{ name: "packages", dir: true }, { name: "scripts", dir: true }], issues, unread, pulls });
  const inProgress = { Status: "In progress" };

  test("the same verdicts as GitHub's answer, and GitHub is asked only for the claim", async () => {
    const r = records([
      issue(10, { labels: ["type:pbi"], subIssues: [11, 12], body: "**前提**: #61" }),
      issue(11, { parent: 10, body: `触る: ${db}` }),
      issue(12, { parent: 10, body: db, fields: inProgress }), // the same PBI's
      issue(30, { body: "`apps/web/src/App.tsx`", fields: inProgress }),
      issue(31, { body: db, fields: inProgress, labels: ["type:task", "needs-decision"] }),
      issue(32, { body: db, fields: { Status: "Backlog" } }),
      issue(61, { labels: ["type:pbi"], state: "CLOSED", stateReason: "COMPLETED" }),
    ], [pull(70, [12], ["packages/core/src/db.ts"]), pull(71, [40], ["packages/core/src/db.ts"]), pull(72, [41], ["packages/core/src/db.ts"], { isDraft: true }), pull(73, [42], null, { state: "MERGED" })]);
    const g = github({ bodies: {} });
    const v = await overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(r, 11) }, 11, true, now);
    expect(v).toMatchObject({ paths: ["packages/core/src/db.ts"], verdict: "defer", blocking: [{ ref: "PR #71" }], prereqs: [{ ref: "#61", state: "met", sibling: false }] });
    expect(g.calls.every((a) => a.includes("POST") || a.includes("DELETE"))).toBe(true);
    expect(g.comments[11] ?? []).toHaveLength(0); // it yields: the claim is withdrawn
    // a stored Task In progress on the file blocks as one read from GitHub does
    const t = records([issue(40, { body: db }), issue(60, { body: db, fields: inProgress })]);
    expect((await overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(t, 40) }, 40, false, now)).blocking.map((h) => h.ref)).toEqual(["Task #60"]);
  });

  test("prerequisites are judged from the stored Issues and PRs; one not stored or not read is missing", async () => {
    const r = (body: string, more: StoredRecords["issues"] = [], pulls: StoredRecords["pulls"] = [], unread: number[] = []) => records([issue(52, { body: `${db}\n\n${body}` }), ...more], pulls, unread);
    const run = (x: StoredRecords) => overlap({ ...ghBoard(REPO, github({ bodies: {} }).run), material: async () => storedMaterial(x, 52) }, 52, false, now);
    expect(await run(r("**前提**: #61", [issue(61)]))).toMatchObject({ verdict: "wait", prereqs: [{ ref: "#61", state: "pending" }] });
    expect(await run(r("**前提**: #70", [], [pull(70, [], [], { state: "CLOSED" })]))).toMatchObject({ verdict: "stop", prereqs: [{ ref: "PR #70", state: "withdrawn" }] });
    expect(await run(r("**前提**: #70（リリース）", [], [pull(70, [], [], { state: "MERGED" })]))).toMatchObject({ verdict: "go", prereqs: [{ ref: "PR #70", state: "met" }] });
    expect(await run(r("**前提**: #99"))).toMatchObject({ verdict: "stop", prereqs: [{ ref: "#99", state: "missing" }] });
    expect(await run(r("**前提**: #61", [issue(61, { state: "CLOSED", stateReason: "COMPLETED" })], [], [61]))).toMatchObject({ verdict: "stop", prereqs: [{ state: "missing" }] });
  });

  test("what cannot be judged from the stored records — a failed fresh read, a PR without its files, a Task not stored — leaves no claim", async () => {
    const g = github({ bodies: {} });
    const failed = async (): Promise<never> => { throw new Error("backlog: 424 GitHub を読めない"); };
    await expect(overlap({ ...ghBoard(REPO, g.run), material: failed }, 40, true, now)).rejects.toThrow("424");
    // an unrelated Draft or the Task's own PR without all its files does not stop the check; a ready one does
    const big = records([issue(40, { body: db, parent: 39 }), issue(39, { labels: ["type:pbi"], subIssues: [40] })], [pull(81, [50], null, { isDraft: true }), pull(82, [40], null)]);
    await expect(overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(big, 40) }, 40, false, now)).rejects.toThrow("変更ファイル"); // its own: its files are its paths
    const draft = records([issue(40, { body: db })], [pull(81, [50], null, { isDraft: true })]);
    expect((await overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(draft, 40) }, 40, false, now)).verdict).toBe("go");
    const nofiles = records([issue(40, { body: db, fields: inProgress })], [pull(80, [50], null)]);
    await expect(overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(nofiles, 40) }, 40, true, now)).rejects.toThrow("変更ファイル");
    await expect(overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(nofiles, 41) }, 41, true, now)).rejects.toThrow("保存されていない");
    // a Task or its PBI the last import could not read is judged from no stale copy
    const unread = records([issue(42, { body: db, parent: 39 }), issue(39, { labels: ["type:pbi"], subIssues: [42] })]);
    await expect(overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial({ ...unread, unread: [42] }, 42) }, 42, true, now)).rejects.toThrow("読めなかった");
    await expect(overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial({ ...unread, unread: [39] }, 42) }, 42, true, now)).rejects.toThrow("読めなかった");
    expect([...(g.comments[40] ?? []), ...(g.comments[41] ?? []), ...(g.comments[42] ?? [])]).toHaveLength(0);
  });
});

describe("parallel-guard on a backlog kept in the app (#2265)", () => {
  test("a withdrawn claim does not hold (#2265)", () => {
    const claimOf = (id: number, token: string) => ({ id, body: `<!-- pbi-complete:claim ${token} -->` });
    const withdraw = (id: number, token: string) => ({ id, body: `<!-- parallel-guard:withdraw ${token} -->\n取り下げ` });
    const release = (id: number) => ({ id, body: releaseBody("終了") });
    expect(holder([claimOf(1, "A"), claimOf(2, "B"), withdraw(3, "B")])).toEqual({ id: 1, token: "A" });
    expect(holder([claimOf(1, "A"), claimOf(2, "B"), withdraw(3, "B"), release(4), claimOf(5, "C")])).toEqual({ id: 5, token: "C" });
    // the first one taken back: the next one holds
    expect(holder([claimOf(1, "A"), claimOf(2, "B"), withdraw(3, "A")])).toEqual({ id: 2, token: "B" });
    const task = (id: number, token: string) => ({ id, body: `<!-- parallel-guard:task-claim ${token} -->\n着手` });
    expect(lastClaim([task(3, "x"), task(9, "y"), withdraw(10, "y")])).toBe(3);
    expect(commentId("sb:000000000042")).toBe(42);
    expect(commentId(1234)).toBe(1234);
  });

  /** The app's backlog API over stored comments `sb:<seq>`; `beforePost` runs before a comment is stored (a rival's write). */
  function app(issues: StoredRecords["issues"], beforePost?: (n: number) => void) {
    let seq = 0;
    const comments: Record<number, Array<{ id: string; body: string }>> = {};
    const add = (n: number, body: string) => (comments[n] ??= []).push({ id: `sb:${String(++seq).padStart(12, "0")}`, body });
    const records: StoredRecords = { workspaceId: "ws_l", service: "switchboard", repository: "ws_l", project: { owner: "switchboard", number: 0 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], issues, unread: [], pulls: [] };
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = url.replace("http://app/api/backlog", "");
      calls.push(`${method} ${path}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (method === "GET" && path === "") return json({ syncs: [{ workspaceId: "ws_l", repository: "ws_l", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] });
      if (method === "GET" && path.startsWith("/records")) return json(records);
      const m = /^\/(\d+)(\/comment)?/.exec(path)!;
      const n = Number(m[1]);
      if (method === "GET") return json({ comments: comments[n] ?? [] });
      beforePost?.(n);
      add(n, (JSON.parse(String(init.body)) as { text: string }).text);
      return json({ operation: "op" }, 202);
    }) as unknown as typeof globalThis.fetch;
    return { board: appBoard({ BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws_l" }, fetch), comments, add, calls };
  }

  test("on a local backlog, claim / release / overlap go through the app, never gh (#2265)", async () => {
    const db = "`packages/core/src/db.ts`";
    const task = (n: number) => ({ number: n, title: "", state: "OPEN" as const, stateReason: null, body: db, labels: ["type:task"], parent: null, subIssues: [], updatedAt: fresh, fields: { Status: "In progress" } });
    const a = app([task(40), task(60)]);
    expect((await claim(a.board, 1, false)).held).toBe(true);
    // a rival's claim stored first: this session withdraws its own with a mark (a stored comment cannot be deleted)
    let raced = false;
    const b = app([], (n) => { if (!raced) { raced = true; b.add(n, "<!-- pbi-complete:claim rival -->"); } });
    expect(await claim(b.board, 1, false)).toEqual({ held: false, holder: { id: 1, token: "rival" } });
    expect(b.comments[1]!.filter((c) => c.body.startsWith("<!-- parallel-guard:withdraw "))).toHaveLength(1);
    expect(holder((b.comments[1] ?? []).map((c) => ({ id: commentId(c.id), body: c.body })))).toEqual({ id: 1, token: "rival" });
    await release(b.board, 1, "終了");
    expect((await claim(b.board, 1, false)).held).toBe(true);
    // two In progress Tasks on one file: the one that marked first goes on, the later one yields and withdraws its mark
    expect((await overlap(a.board, 60, true, now)).verdict).toBe("go");
    const late = await overlap(a.board, 40, true, now);
    expect(late).toMatchObject({ verdict: "defer", blocking: [{ ref: "Task #60" }] });
    expect(a.comments[40]!.map((c) => c.body.split("\n")[0]!.replace(/ [0-9a-f-]{36} /, " <token> "))).toEqual(["<!-- parallel-guard:task-claim <token> -->", "<!-- parallel-guard:withdraw <token> -->"]);
    expect(lastClaim(a.comments[40]!.map((c) => ({ id: commentId(c.id), body: c.body })))).toBeUndefined();
    // #60 still goes when it marks again (#40's mark is taken back); only the app was asked
    expect((await overlap(a.board, 60, true, now)).verdict).toBe("go");
    expect([...a.calls, ...b.calls].every((c) => /^(GET|POST) (|\/records\?.*|\/\d+(\?.*|\/comment))$/.test(c))).toBe(true);
  });
});

test("a local backlog's Task that cannot reach the app stops (exit 2), never falling back to gh (#2265)", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-local-"));
  try {
    const called = `${dir}/gh-called`;
    writeFileSync(`${dir}/gh`, `#!/bin/sh\ntouch ${called}\nexit 1\n`, { mode: 0o755 });
    // run in this checkout, which has a GitHub origin: the gh path would be open if it fell back
    const r = Bun.spawnSync([process.execPath, `${import.meta.dir}/parallel-guard.ts`, "claim", "1"], {
      cwd: import.meta.dir,
      env: { PATH: `${dir}:${process.env.PATH}`, BACKLOG_URL: "http://127.0.0.1:9/api/backlog", BACKLOG_WORKSPACE: "ws_local", HOME: process.env.HOME ?? dir },
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("判定できなかった");
    expect(existsSync(called)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
