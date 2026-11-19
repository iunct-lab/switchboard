// test-reads: scripts/parallel-guard.ts docs/design/pbi-progress.md
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterTime, appBoard, claim, ghBoard, ghMaterial, holder, judge, lastClaim, overlap, readOthers, release, releaseArgs, releaseBody, STALE_HOURS, storedMaterial, waitConditions, waitsOnlyForCheck, type Work } from "./parallel-guard";
import { linkedIssues } from "./task-paths";
import { pathsIn } from "../ops-kit/src/task-paths";
import type { StoredRecords } from "../ops-kit/src/backlog-client";
import { readProgressTable } from "../packages/core/src/pbi-progress.table";

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

  test("a Task that only refers to a root file in a step does not block; one that names it at the head of a step does, and two of those defer", () => {
    const refers = pathsIn("1. 規則は README.md に従う", top);
    const touches = pathsIn("1. README.md: 追記する", top);
    expect(judge({ paths: touches }, [task(40, refers)], now).verdict).toBe("go");
    expect(judge({ paths: touches }, [task(40, touches)], now).verdict).toBe("defer");
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
  targets?: Record<number, { state: "open" | "closed"; state_reason?: string; pr?: boolean; merged?: boolean; body?: string; labels?: string[]; sub?: { total: number; completed: number } }>; // the Issues / PRs named as prerequisites; others 404
  inProgress?: number[];
  projects?: Record<number, { number: number; owner: { login: string }; status: string }[]>; // other Projects a Task is in, listed first
  prs?: { number: number; headRefName: string; body: string; files: string[]; isDraft?: boolean; labels?: { name: string }[] }[];
  decisionTasks?: number[];
  taskParents?: Record<number, number>; // the PBI of a Task listed by the issues query
  comments?: Record<number, { id: number; body: string }[]>;
  timeline?: Record<number, { number: number; state: string; body: string; headRefName: string; repository?: { nameWithOwner: string } }[]>; // the PRs that refer to an Issue (the timeline query)
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
    const asked = args.find((a) => a.includes("CROSS_REFERENCED_EVENT"));
    if (asked) {
      const repository = Object.fromEntries([...asked.matchAll(/t(\d+): issue/g)].map((m) => [`t${m[1]}`, { timelineItems: { nodes: (opts.timeline?.[Number(m[1])] ?? []).map((source) => ({ source: { repository: { nameWithOwner: REPO }, ...source } })) } }]));
      return JSON.stringify({ data: { repository } });
    }
    if (args[1] === "graphql" && args.some((a) => a.includes("issues("))) {
      return Object.entries(opts.bodies).map(([n, body]) => JSON.stringify({
        number: Number(n), body, updatedAt: fresh, parent: opts.taskParents?.[Number(n)] ? { number: opts.taskParents[Number(n)] } : null, labels: { nodes: opts.decisionTasks?.includes(Number(n)) ? [{ name: "needs-decision" }] : [] },
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
      return JSON.stringify({ state: t.state, state_reason: t.state_reason ?? null, merged: !!t.merged, pr: !!t.pr, body: t.body ?? "", labels: t.labels ?? [], sub: t.sub ?? { total: 0, completed: 0 } });
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

describe("parallel-guard after", () => {
  const AT = "2026-11-20T09:00:00+09:00";
  test("--after is written into the release mark, with or without waits, and holder() still reads it as a release", () => {
    expect(releaseBody("期日待ち", [], false, AT)).toBe(`<!-- pbi-complete:release after=${AT} -->\n/pbi-complete 終了: 期日待ち`);
    expect(releaseBody("x", [778, 603], false, "2026-11-20T00:00:00Z").split("\n")[0]).toBe("<!-- pbi-complete:release waits=603,778 after=2026-11-20T00:00:00Z -->");
    expect(releaseBody("x", [52], true, AT).split("\n")[0]).toBe(`<!-- pbi-complete:release overlap=52 after=${AT} -->`);
    for (const body of [releaseBody("x", [], false, AT), releaseBody("x", [603], false, AT)]) {
      expect(holder([{ id: 1, body: "<!-- pbi-complete:claim t1 -->" }, { id: 2, body }])).toBeNull();
    }
  });

  test("the CLI's words: --after splits out of the reason and goes with --waits; a time with no zone, an unreadable time, a missing or repeated value is a usage error", () => {
    expect(releaseArgs(["期日待ち", "--after", AT])).toEqual({ reason: "期日待ち", waits: [], after: AT });
    expect(releaseArgs(["--after", "2026-11-20T00:00:00Z", "後回し", "--waits", "9"])).toEqual({ reason: "後回し", waits: [9], after: "2026-11-20T00:00:00Z" });
    expect(releaseArgs(["x", "--overlap-waits", "9", "--after", AT])).toEqual({ reason: "x", waits: [9], overlap: true, after: AT });
    for (const bad of [["x", "--after", "2026-11-20T09:00:00"], ["x", "--after", "2026-11-20"], ["x", "--after", "あした"], ["x", "--after"], ["--after", AT], ["x", "--after", AT, "--after", AT]]) expect(releaseArgs(bad)).toBeNull();
  });

  test("afterTime reads only a time with a zone", () => {
    expect(afterTime(AT)).toBe(Date.parse(AT));
    expect(afterTime("2026-11-20T00:00:00Z")).toBe(Date.parse("2026-11-20T00:00:00Z"));
    expect(afterTime("2026-11-20T00:00:00")).toBeNaN();
    // a date Date.parse reads but no marker can carry (a space) is no ISO 8601 time, so --after refuses it
    expect(afterTime("Fri, 20 Nov 2026 00:00:00Z")).toBeNaN();
    expect(releaseArgs(["x", "--after", "Fri, 20 Nov 2026 00:00:00Z"])).toBeNull();
  });

  test("release posts the mark with the date", async () => {
    const g = github({ bodies: {} }); await release(ghBoard(REPO, g.run), 7, "期日待ち", [], false, AT);
    expect(g.comments[7]![0]!.body).toContain(`release after=${AT}`);
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
    // the ready PR stands for the Task: its files hold, the Task's body no longer adds to them
    expect((await overlap(ghBoard(REPO, make(false).run), 11, false, now)).blocking.map((h) => h.ref)).toEqual(["PR #49"]);
  });

  test("a Task with a ready PR is judged by the PR's files, not by what its body planned", async () => {
    const make = (draft: boolean) => github({
      bodies: { 11: "触る: `packages/core/src/server.ts`", 52: "触る: `packages/core/src/server.ts`、`packages/core/src/jobs.ts`" },
      inProgress: [52],
      prs: [{ number: 49, headRefName: "sb/52-x", body: "", files: ["packages/core/src/jobs.ts"], isDraft: draft }],
    });
    expect((await overlap(ghBoard(REPO, make(false).run), 11, false, now)).verdict).toBe("go");
    expect((await overlap(ghBoard(REPO, make(true).run), 11, false, now)).blocking.map((h) => h.ref)).toEqual(["Task #52"]);
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

  test("after: from GitHub too, an In progress Task whose PBI waits for a date still ahead holds no file, however many comments follow the mark", async () => {
    const material = (after: string) => {
      const later = Array.from({ length: 40 }, (_, i) => ({ id: 200 + i, body: `進み ${i}` }));
      const g = github({
        bodies: { 11: "packages/core/src/db.ts", 12: "packages/core/src/db.ts" },
        parents: { 11: { number: 10, subs: [11] } },
        inProgress: [12],
        taskParents: { 12: 59 },
        comments: { 59: [{ id: 150, body: `<!-- pbi-complete:release after=${after} -->\n/pbi-complete 終了: 期日待ち` }, ...later] },
      });
      return ghMaterial(REPO, 11, g.run, now.getTime());
    };
    expect((await readOthers(11, await material("2026-10-01T00:00:00Z"))).others.map((w) => w.ref)).toEqual([]);
    expect((await readOthers(11, await material("2026-09-28T12:00:00Z"))).others.map((w) => w.ref)).toEqual(["Task #12"]); // at the date it holds again
  });

  // a review's follow-up: a root file only an open PR adds is not in the repository's root yet
  test("a new root file or directory an open PR adds is a path in the Task too", async () => {
    const g = github({
      bodies: { 11: "触る: new-config.json と tools/gen.ts を足す。packages/core/src/db.ts" },
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

  test("a Task that only waits for a check is read from the PRs that refer to it, and not asked when an open PR is known", async () => {
    const merged = { number: 70, state: "MERGED", body: "Refs #60", headRefName: "sb/60-done" };
    const timelineCalls = (g: ReturnType<typeof github>) => g.calls.filter((a) => a.some((x) => x.includes("CROSS_REFERENCED_EVENT"))).length;
    const run = (g: ReturnType<typeof github>) => overlap(ghBoard(REPO, g.run), 40, false, now);
    const only = github({ bodies: { 40: db, 60: db }, inProgress: [60], timeline: { 60: [merged, { number: 71, state: "MERGED", body: "Closes #99", headRefName: "sb/99-x" }] } });
    expect((await run(only)).verdict).toBe("go"); // the merged PR is linked by its branch; the other one names another Task
    expect(timelineCalls(only)).toBe(1);
    const open = github({ bodies: { 40: db, 60: db }, inProgress: [60], timeline: { 60: [merged, { number: 72, state: "OPEN", body: "Closes #60", headRefName: "sb/60-more" }] } });
    expect((await run(open)).verdict).toBe("defer");
    const unmerged = github({ bodies: { 40: db, 60: db }, inProgress: [60], timeline: { 60: [{ ...merged, state: "CLOSED" }] } });
    expect((await run(unmerged)).verdict).toBe("defer");
    // a merged PR of another repository on the branch `sb/60-` is that repository's Task, not this one
    const foreign = github({ bodies: { 40: db, 60: db }, inProgress: [60], timeline: { 60: [{ ...merged, repository: { nameWithOwner: "someone/other" } }] } });
    expect((await run(foreign)).verdict).toBe("defer");
    // a Task with an open PR is judged by the list of open PRs: no timeline call; nor when no Task is In progress
    const listed = github({ bodies: { 40: db, 60: db }, inProgress: [60], timeline: { 60: [merged] }, prs: [{ number: 73, headRefName: "sb/60-open", body: "Closes #60", files: ["packages/core/src/db.ts"] }] });
    expect((await run(listed)).verdict).toBe("defer");
    expect(timelineCalls(listed)).toBe(0);
    const none = github({ bodies: { 40: db } });
    expect((await run(none)).verdict).toBe("go");
    expect(timelineCalls(none)).toBe(0);
  });

  // a review's case: `#40` and `#60` both pass the check before either is In progress; `#60` claims and rechecks first,
  // then `#40` claims. `#40` must not go on just because its number is smaller.
  test("of two staggered starts on the same file only the first claim goes on", async () => {
    const g = github({ bodies: { 40: db, 60: db } });
    expect((await overlap(ghBoard(REPO, g.run), 60, false, now)).verdict).toBe("go"); // both checks pass: nothing In progress yet
    expect((await overlap(ghBoard(REPO, g.run), 40, false, now)).verdict).toBe("go");
    const g2 = github({ bodies: { 40: db, 60: db }, inProgress: [60] });
    expect((await overlap(ghBoard(REPO, g2.run), 60, true, now)).verdict).toBe("go"); // `#40` not In progress yet
    const g3 = github({ bodies: { 40: db, 60: db }, inProgress: [40, 60], comments: g2.comments });
    const late = await overlap(ghBoard(REPO, g3.run), 40, true, now);
    expect(late.verdict).toBe("defer");
    expect(late.blocking.map((h) => h.ref)).toEqual(["Task #60"]);
    expect(g3.comments[40] ?? []).toHaveLength(0); // the yielding Task withdraws its claim
    expect(g3.comments[60]).toHaveLength(1);
  });

  test("claiming at the same time: the later claim yields, the earlier one goes on", async () => {
    const g = github({ bodies: { 40: db, 60: db }, inProgress: [40, 60] });
    const first = await overlap(ghBoard(REPO, g.run), 60, true, now); // claims 100; `#40` has no claim yet → `#40` will yield
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

describe("parallel-guard overlap conditions", () => {
  const hit = (ref: string) => ({ ref, path: "packages/a.ts", updatedAt: fresh });

  test("a blocking PR and Task become pr# / issue# wait keys, once each; another PBI's prerequisite waits by its state", () => {
    expect(waitConditions({ verdict: "defer", blocking: [hit("PR #12"), hit("PR #12"), hit("Task #34")] })).toEqual([
      { key: "pr#12", value: "open", met: false },
      { key: "issue#34", value: "open", met: false },
    ]);
    expect(waitConditions({ verdict: "wait", blocking: [], prereqs: [
      { ref: "#61", state: "pending", sibling: false },
      { ref: "PR #62", state: "pending", sibling: false },
      { ref: "#53", state: "pending", sibling: true },
      { ref: "#64", state: "met", sibling: false },
    ] })).toEqual([{ key: "issue#61", value: "pending", met: false }, { key: "pr#62", value: "pending", met: false }]);
  });

  test("a go waits for nothing", () => {
    expect(waitConditions({ verdict: "go", blocking: [], prereqs: [{ ref: "#53", state: "pending", sibling: true }] })).toEqual([]);
  });

  test("overlap prints the conditions when it cannot go", async () => {
    const g = github({ bodies: { 60: "packages/shared.ts" }, prs: [{ number: 140, headRefName: "sb/40-x", body: "Closes #40", files: ["packages/shared.ts"] }] });
    expect(await overlap(ghBoard(REPO, g.run), 60, false, now)).toMatchObject({ verdict: "defer", conditions: [{ key: "pr#140", value: "open", met: false }] });
  });
});

describe("parallel-guard prereqs", () => {
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

  test("an Issue named （リリース） carries how to fix it; a PR does not", async () => {
    const issue = await overlap(ghBoard(REPO, task("**前提**: #71（リリース）", { targets: { 71: { state: "closed" } } }).run), 52, false, now);
    expect(issue.prereqs[0]).toMatchObject({ ref: "#71", state: "unknown", fix: expect.stringContaining("PR の番号に書き直す") });
    const pr = await overlap(ghBoard(REPO, task("**前提**: #70（リリース）", { targets: { 70: { state: "open", pr: true } } }).run), 52, false, now);
    expect(pr.prereqs[0]).not.toHaveProperty("fix");
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

  const pbi = (left: string) => `## 到達点 / 受け入れ条件\n- [x] 済んだ行\n${left}\n`;
  const mine = "- [ ] 画面で見る（利用者確認: 見た目を見る）";

  test("a prerequisite left with only the person's checks does not wait", async () => {
    const closed = { total: 2, completed: 2 };
    const t = (extra: { body?: string; labels?: string[]; sub?: { total: number; completed: number } }) => ({ 61: { state: "open" as const, labels: ["type:pbi"], sub: closed, body: pbi(mine), ...extra } });
    const go = await overlap(ghBoard(REPO, task("**前提**: #61", { targets: t({}) }).run), 52, false, now);
    expect(go).toMatchObject({ verdict: "go", prereqs: [{ ref: "#61", state: "met", confirming: true }] });
    // a Task still open, or needs-decision: it waits as before
    expect(await overlap(ghBoard(REPO, task("**前提**: #61", { targets: t({ sub: { total: 2, completed: 1 } }) }).run), 52, false, now)).toMatchObject({ verdict: "wait" });
    expect(await overlap(ghBoard(REPO, task("**前提**: #61", { targets: t({ labels: ["type:pbi", "needs-decision"] }) }).run), 52, false, now)).toMatchObject({ verdict: "wait" });
    // the same judgment from the app's stored records; a child not stored counts as open
    const stored = (over: Partial<StoredRecords["issues"][number]>, children: StoredRecords["issues"]) => ({
      workspaceId: "w", service: "github", repository: REPO, project: { owner: "example", number: 8 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], unread: [], pulls: [], comments: [],
      issues: [
        { number: 52, title: "", url: "", state: "OPEN", stateReason: null, body: `${db}\n\n**前提**: #61`, labels: ["type:task"], parent: 50, subIssues: [], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null },
        { number: 50, title: "", url: "", state: "OPEN", stateReason: null, body: "", labels: ["type:pbi"], parent: null, subIssues: [52], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null },
        { number: 61, title: "", url: "", state: "OPEN", stateReason: null, body: pbi(mine), labels: ["type:pbi"], parent: null, subIssues: [62, 63], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null, ...over },
        ...children,
      ],
    } as StoredRecords);
    const child = (n: number, state: "OPEN" | "CLOSED") => ({ number: n, title: "", url: "", state, stateReason: null, body: "", labels: ["type:task"], parent: 61, subIssues: [], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null } as StoredRecords["issues"][number]);
    const run = (r: StoredRecords) => overlap({ ...ghBoard(REPO, github({ bodies: {} }).run), material: async () => storedMaterial(r, 52) }, 52, false, now);
    expect(await run(stored({}, [child(62, "CLOSED"), child(63, "CLOSED")]))).toMatchObject({ verdict: "go", prereqs: [{ ref: "#61", state: "met", confirming: true }] });
    expect(await run(stored({}, [child(62, "CLOSED")]))).toMatchObject({ verdict: "wait" });
    // a child stored as closed but not read on the last fetch counts as open: the guard leans to waiting
    expect(await run({ ...stored({}, [child(62, "CLOSED"), child(63, "CLOSED")]), unread: [63] })).toMatchObject({ verdict: "wait" });
  });

  test("a prerequisite with an unchecked line that is not the person's still waits", async () => {
    const targets = { 61: { state: "open" as const, labels: ["type:pbi"], sub: { total: 1, completed: 1 }, body: pbi(`${mine}\n- [ ] 直す行（検証: テスト）`) } };
    expect(await overlap(ghBoard(REPO, task("**前提**: #61", { targets }).run), 52, false, now)).toMatchObject({ verdict: "wait", prereqs: [{ ref: "#61", state: "pending" }] });
    // no unchecked line at all is not "only checks left" either
    const none = { 61: { ...targets[61], body: pbi("") } };
    expect(await overlap(ghBoard(REPO, task("**前提**: #61", { targets: none }).run), 52, false, now)).toMatchObject({ verdict: "wait" });
  });

  test("prerequisites: the guard reads the same table as the app", async () => {
    // every row of docs/design/pbi-progress.md a body can say (the decided / held columns come from the app's stored decisions),
    // as an open Issue `#61` named as a prerequisite, read both ways the guard reads: from GitHub and from the app's records
    const rows = readProgressTable().filter((r) => r.facts.decided.length === 0 && !r.facts.held);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.some((r) => r.want.prereqMet) && rows.some((r) => !r.want.prereqMet)).toBe(true);
    for (const { row, facts, want } of rows) {
      const last = Math.max(0, ...facts.confirms, ...facts.postMerge) + facts.others + 1;
      let others = facts.others;
      const lines = Array.from({ length: last }, (_, k) => k + 1).map((n) => (facts.confirms.includes(n) ? `- [ ] ${n}. 見る（利用者確認: 画面で見る）` : facts.postMerge.includes(n) ? `- [ ] ${n}. 動かす（マージの後: 画面）` : others-- > 0 ? `- [ ] ${n}. 直す（検証: テスト）` : `- [x] ${n}. 済み`));
      const body = `## 到達点 / 受け入れ条件\n${lines.join("\n")}\n`;
      const labels = [facts.pbi ? "type:pbi" : "type:task", ...(facts.decision ? ["needs-decision"] : [])];
      const expected = want.prereqMet ? { verdict: "go", prereqs: [{ ref: "#61", state: "met", confirming: true }] } : { verdict: "wait", prereqs: [{ ref: "#61", state: "pending" }] };
      const fromGithub = await overlap(ghBoard(REPO, task("**前提**: #61", { targets: { 61: { state: "open" as const, labels, sub: { total: facts.tasks.total, completed: facts.tasks.done }, body } } }).run), 52, false, now);
      expect({ row, from: "GitHub", ...fromGithub }).toMatchObject({ row, ...expected });
      const issue = (n: number, over: Partial<StoredRecords["issues"][number]>) => ({ number: n, title: "", url: "", state: "OPEN", stateReason: null, body: "", labels: ["type:task"], parent: null, subIssues: [], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null, ...over } as StoredRecords["issues"][number]);
      const children = Array.from({ length: facts.tasks.total }, (_, k) => issue(600 + k, { parent: 61, state: k < facts.tasks.done ? "CLOSED" : "OPEN" }));
      const records = {
        workspaceId: "w", service: "github", repository: REPO, project: { owner: "example", number: 8 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], unread: [], pulls: [], comments: [],
        // the Status the table names is stored too: the guard must not read it
        issues: [issue(52, { body: `${db}\n\n**前提**: #61`, parent: 50 }), issue(50, { labels: ["type:pbi"], subIssues: [52] }), issue(61, { body, labels, subIssues: children.map((c) => c.number), fields: facts.status ? { Status: facts.status } : null }), ...children],
      } as StoredRecords;
      const fromApp = await overlap({ ...ghBoard(REPO, github({ bodies: {} }).run), material: async () => storedMaterial(records, 52) }, 52, false, now);
      expect({ row, from: "the app's records", ...fromApp }).toMatchObject({ row, ...expected });
    }
  });

  test("a Task that has to wait withdraws its claim", async () => {
    const g = task("**前提**: #61", { targets: { 61: { state: "open" } }, inProgress: [52] });
    expect((await overlap(ghBoard(REPO, g.run), 52, true, now)).verdict).toBe("wait");
    expect(g.comments[52] ?? []).toHaveLength(0);
  });
});

describe("parallel-guard from the app's stored records", () => {
  const db = "`packages/core/src/db.ts`";
  const issue = (n: number, over: Partial<StoredRecords["issues"][number]> = {}): StoredRecords["issues"][number] => ({ number: n, title: "", url: "", state: "OPEN", stateReason: null, body: "", labels: ["type:task"], parent: null, subIssues: [], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null, ...over });
  const pull = (n: number, closes: number[], files: string[] | null, over: Partial<StoredRecords["pulls"][number]> = {}): StoredRecords["pulls"][number] => ({ number: n, state: "OPEN", isDraft: false, labels: [], closes, mergeCommit: null, updatedAt: fresh, files, ...over });
  const records = (issues: StoredRecords["issues"], pulls: StoredRecords["pulls"] = [], unread: number[] = []): StoredRecords => ({ workspaceId: "w", service: "github", repository: REPO, project: { owner: "example", number: 8 }, fetchedAt: 1, top: [{ name: "packages", dir: true }, { name: "scripts", dir: true }], issues, unread, pulls, comments: [] });
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

  test("after: an In progress Task whose PBI waits for a date still ahead holds no file until the date", async () => {
    const mark = (after: string) => ({ issue: 59, body: `<!-- pbi-complete:release after=${after} -->\n/pbi-complete 終了: 期日待ち`, createdAt: fresh });
    const t = (after: string) => ({ ...records([issue(40, { body: db }), issue(59, { labels: ["type:pbi"], subIssues: [60] }), issue(60, { parent: 59, body: db, fields: inProgress })]), comments: [mark(after)] });
    const run = (x: StoredRecords) => overlap({ ...ghBoard(REPO, github({ bodies: {} }).run), material: async () => storedMaterial(x, 40, now.getTime()) }, 40, false, now);
    expect((await run(t("2026-10-01T00:00:00Z"))).verdict).toBe("go"); // the date is ahead
    expect((await run(t("2026-09-28T12:00:00Z"))).blocking.map((h) => h.ref)).toEqual(["Task #60"]); // at the date it holds again
  });

  test("a Task that only waits for a check does not block", async () => {
    const run = (pulls: StoredRecords["pulls"]) => overlap({ ...ghBoard(REPO, github({ bodies: {} }).run), material: async () => storedMaterial(records([issue(40, { body: db }), issue(60, { body: `触る: ${db}`, fields: inProgress })], pulls), 40) }, 40, false, now);
    expect((await run([pull(71, [60], ["packages/core/src/db.ts"], { state: "MERGED" })])).verdict).toBe("go"); // merged, nothing open: only the check is left
    expect((await run([pull(71, [60], ["packages/core/src/db.ts"], { state: "MERGED" }), pull(72, [60], ["packages/core/src/db.ts"], { isDraft: true })])).verdict).toBe("defer"); // a Draft is open work
    expect((await run([pull(71, [60], ["packages/core/src/db.ts"], { state: "MERGED" }), pull(72, [60], ["packages/core/src/db.ts"])])).verdict).toBe("defer");
    expect((await run([pull(71, [60], ["packages/core/src/db.ts"], { state: "CLOSED" })])).verdict).toBe("defer"); // never merged
    expect((await run([])).verdict).toBe("defer"); // no merged PR in the records: not taken for waiting
  });

  test("waitsOnlyForCheck reads only the PRs linked to the Task", () => {
    expect(waitsOnlyForCheck(5, [{ state: "MERGED", linked: [5] }])).toBe(true);
    expect(waitsOnlyForCheck(5, [{ state: "MERGED", linked: [5] }, { state: "OPEN", linked: [6] }])).toBe(true);
    expect(waitsOnlyForCheck(5, [{ state: "MERGED", linked: [5] }, { state: "OPEN", linked: [5, 6] }])).toBe(false);
    expect(waitsOnlyForCheck(5, [{ state: "CLOSED", linked: [5] }])).toBe(false);
    expect(waitsOnlyForCheck(5, [])).toBe(false);
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

describe("parallel-guard on a backlog kept in the app", () => {
  test("a withdrawn claim does not hold", () => {
    const claimOf = (id: number, token: string) => ({ id, body: `<!-- pbi-complete:claim ${token} -->` });
    const withdraw = (id: number, token: string) => ({ id, body: `<!-- parallel-guard:withdraw ${token} -->\n取り下げ` });
    const release = (id: number) => ({ id, body: releaseBody("終了") });
    expect(holder([claimOf(1, "A"), claimOf(2, "B"), withdraw(3, "B")])).toEqual({ id: 1, token: "A" });
    expect(holder([claimOf(1, "A"), claimOf(2, "B"), withdraw(3, "B"), release(4), claimOf(5, "C")])).toEqual({ id: 5, token: "C" });
    // the first one taken back: the next one holds
    expect(holder([claimOf(1, "A"), claimOf(2, "B"), withdraw(3, "A")])).toEqual({ id: 2, token: "B" });
    const task = (id: number, token: string) => ({ id, body: `<!-- parallel-guard:task-claim ${token} -->\n着手` });
    expect(lastClaim([task(3, "x"), task(9, "y"), withdraw(10, "y")])).toBe(3);
  });

  /** The app's backlog API over stored comments `sb:<seq>`; `beforePost` runs before a comment is stored (a rival's write). */
  /** `lease`: what the app answers on POST /:n/lease (the body, or a status to fail with); unset = it runs alone (`enabled: false`). */
  function app(issues: StoredRecords["issues"], beforePost?: (n: number) => void, lease?: (action: string) => unknown) {
    let seq = 0;
    const comments: Record<number, Array<{ id: string; seq: number; body: string; createdAt: string }>> = {};
    const add = (n: number, body: string) => (comments[n] ??= []).push({ id: `sb:${String(++seq).padStart(12, "0")}`, seq, body, createdAt: fresh });
    const records: StoredRecords = { workspaceId: "ws_l", service: "switchboard", repository: "ws_l", project: { owner: "switchboard", number: 0 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], issues, unread: [], pulls: [] };
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = url.replace("http://app/api/backlog", "");
      calls.push(`${method} ${path}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (method === "GET" && path === "/syncs") return json({ syncs: [{ workspaceId: "ws_l", repository: "ws_l", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] });
      if (method === "GET" && path.startsWith("/records")) return json(records);
      const m = /^\/(\d+)(\/comment)?/.exec(path)!;
      const n = Number(m[1]);
      if (method === "GET") return json({ comments: comments[n] ?? [] });
      if (path.endsWith("/lease")) {
        const answer = lease ? lease((JSON.parse(String(init.body)) as { action: string }).action) : { enabled: false };
        return typeof answer === "number" ? json({ error: "S3 に届かない" }, answer) : json(answer);
      }
      beforePost?.(n);
      add(n, (JSON.parse(String(init.body)) as { text: string }).text);
      return json({ operation: "op" }, 202);
    }) as unknown as typeof globalThis.fetch;
    return { board: appBoard({ BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws_l" }, fetch), comments, add, calls };
  }

  test("lease: an app that runs alone is asked and answers enabled false — claim and release go on as before", async () => {
    const a = app([]);
    expect(await claim(a.board, 1, false)).toMatchObject({ held: true });
    await release(a.board, 1, "完了");
    expect(a.calls.filter((c) => c.endsWith("/lease"))).toEqual(["POST /1/lease", "POST /1/lease"]);
    expect(a.comments[1]!.map((c) => /pbi-complete:(\w+)/.exec(c.body)?.[1])).toEqual(["claim", "release"]);
  });

  test("lease: a PBI another machine holds is not claimed — the claim comment is taken back and the line says who holds it until when", async () => {
    const line = "PBI #1 は pc1 が 2026-11-17 09:30 UTC まで持っている";
    const a = app([], undefined, () => ({ enabled: true, ok: false, holder: "pc1", until: 1, error: line }));
    expect(await claim(a.board, 1, false)).toEqual({ held: false, holder: null, leased: line });
    expect(holder(await a.board.comments(1))).toBeNull();
    expect(a.comments[1]!.map((c) => /(pbi-complete:claim|parallel-guard:withdraw)/.exec(c.body)?.[1])).toEqual(["pbi-complete:claim", "parallel-guard:withdraw"]);
  });

  test("lease: taken with the claim and given back with the release; a lease that cannot be asked for takes the claim back and is not judged", async () => {
    const asked: string[] = [];
    const a = app([], undefined, (action) => (asked.push(action), { enabled: true, ok: true }));
    expect((await claim(a.board, 1, false)).held).toBe(true);
    await release(a.board, 1, "完了");
    expect(asked).toEqual(["acquire", "release"]);
    const down = app([], undefined, () => 424);
    await expect(claim(down.board, 2, false)).rejects.toThrow("S3 に届かない");
    expect(holder(await down.board.comments(2))).toBeNull();
  });

  test("lease: GitHub's comments alone (no app) have no lease to ask for", async () => {
    const g = github({ bodies: {} });
    expect(ghBoard(REPO, g.run).lease).toBeUndefined();
    expect(await claim(ghBoard(REPO, g.run), 7, false)).toMatchObject({ held: true });
  });

  test("on a local backlog, claim / release / overlap go through the app, never gh", async () => {
    const db = "`packages/core/src/db.ts`";
    const task = (n: number) => ({ number: n, title: "", state: "OPEN" as const, stateReason: null, body: db, labels: ["type:task"], parent: null, subIssues: [], updatedAt: fresh, fields: { Status: "In progress" } });
    const a = app([task(40), task(60)]);
    expect((await claim(a.board, 1, false)).held).toBe(true);
    // a rival's claim stored first: this session withdraws its own with a mark (a stored comment cannot be deleted)
    let raced = false;
    const b = app([], (n) => { if (!raced) { raced = true; b.add(n, "<!-- pbi-complete:claim rival -->"); } });
    expect(await claim(b.board, 1, false)).toEqual({ held: false, holder: { id: 1, token: "rival" } });
    expect(b.comments[1]!.filter((c) => c.body.startsWith("<!-- parallel-guard:withdraw "))).toHaveLength(1);
    expect(holder((b.comments[1] ?? []).map((c) => ({ id: c.seq, body: c.body })))).toEqual({ id: 1, token: "rival" });
    await release(b.board, 1, "終了");
    expect((await claim(b.board, 1, false)).held).toBe(true);
    // two In progress Tasks on one file: the one that marked first goes on, the later one yields and withdraws its mark
    expect((await overlap(a.board, 60, true, now)).verdict).toBe("go");
    const late = await overlap(a.board, 40, true, now);
    expect(late).toMatchObject({ verdict: "defer", blocking: [{ ref: "Task #60" }] });
    expect(a.comments[40]!.map((c) => c.body.split("\n")[0]!.replace(/ [0-9a-f-]{36} /, " <token> "))).toEqual(["<!-- parallel-guard:task-claim <token> -->", "<!-- parallel-guard:withdraw <token> -->"]);
    expect(lastClaim(a.comments[40]!.map((c) => ({ id: c.seq, body: c.body })))).toBeUndefined();
    // `#60` still goes when it marks again (`#40`'s mark is taken back); only the app was asked
    expect((await overlap(a.board, 60, true, now)).verdict).toBe("go");
    expect([...a.calls, ...b.calls].every((c) => /^(GET|POST) (\/syncs|\/records\?.*|\/\d+(\?.*|\/comment|\/lease))$/.test(c))).toBe(true);
  });
});

test("a local backlog's Task that cannot reach the app stops (exit 2), never falling back to gh", () => {
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

describe("parallel-guard on a GitHub-synced backlog through the app", () => {
  const stamp = "2026-09-28T11:00:00.000Z";
  const task = { number: 40, title: "", url: "", state: "OPEN", stateReason: null, body: "`packages/core/src/db.ts`", labels: ["type:task"], parent: null, subIssues: [], createdAt: stamp, updatedAt: stamp, closedAt: null, fields: { Status: "In progress" } };

  /** The app's API over stored comments of `acme/lib`, and a gh that records its calls. */
  function fakes(syncStatus = 200) {
    let imports = 0;
    const dir = mkdtempSync(join(tmpdir(), "guard-synced-"));
    const log = `${dir}/gh-calls`;
    writeFileSync(log, "");
    writeFileSync(`${dir}/gh`, `#!/bin/sh\necho "$*" >> ${log}\necho '{"id":1}'\n`, { mode: 0o755 });
    let seq = 0;
    const comments: Record<number, Array<{ id: string; seq: number | null; body: string; createdAt: string }>> = {};
    const synced = async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname.replace("/api/backlog", "");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/syncs") return json({ syncs: [{ workspaceId: "ws_g", repository: "acme/lib", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] });
      if (path === "/records") return json({ workspaceId: "ws_g", service: "github", repository: "acme/lib", project: { owner: "acme", number: 1 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], issues: [task], unread: [], pulls: [], comments: [] });
      if (path === "/sync") {
        imports += 1;
        return json(syncStatus === 200 ? {} : { error: "GitHub に届かない" }, syncStatus);
      }
      // this app runs alone: it has no lease to give
      if (/^\/\d+\/lease$/.test(path)) return json({ enabled: false });
      const m = /^\/(\d+)(\/comment)?$/.exec(path)!;
      const n = Number(m[1]);
      if (req.method === "GET") return json({ comments: comments[n] ?? [] });
      seq += 1;
      (comments[n] ??= []).push({ id: `local:${seq}`, seq, body: ((await req.json()) as { text: string }).text, createdAt: stamp });
      return json({ operation: "op" }, 202);
    };
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: synced });
    let stderr = "";
    const guard = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, `${import.meta.dir}/parallel-guard.ts`, ...args], {
        cwd: import.meta.dir,
        env: { PATH: `${dir}:${process.env.PATH}`, BACKLOG_URL: `http://127.0.0.1:${server.port}/api/backlog`, GH_REPO: "acme/lib", HOME: process.env.HOME ?? dir },
        stdout: "pipe", stderr: "pipe",
      });
      stderr = await new Response(p.stderr).text();
      await p.exited;
      return p.exitCode;
    };
    const ghCalls = () => Bun.file(log).text().then((t) => t.split("\n").filter(Boolean));
    const done = () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); };
    return { comments, guard, ghCalls, done, synced: () => imports, stderr: () => stderr };
  }

  test("claim / release / task-claim go to the app; gh never writes issue comments", async () => {
    const f = fakes();
    try {
      expect(await f.guard("claim", "7")).toBe(0);
      expect(await f.guard("release", "7", "完了")).toBe(0);
      expect(await f.guard("overlap", "40", "--claimed")).toBe(0);
      expect(f.comments[7]!.map((c) => /<!-- pbi-complete:(\w+)/.exec(c.body)?.[1])).toEqual(["claim", "release"]);
      expect(f.comments[40]![0]!.body).toStartWith("<!-- parallel-guard:task-claim ");
      expect(await f.ghCalls()).toEqual([]);
    } finally { f.done(); }
  });

  test("--repo the app syncs goes through the app; --repo it does not know goes to GitHub", async () => {
    const f = fakes();
    try {
      expect(await f.guard("claim", "7", "--repo", "ACME/lib")).toBe(0); // the list is read as the app reads it, any case
      expect(f.comments[7]).toHaveLength(1);
      expect(await f.ghCalls()).toEqual([]);
      await f.guard("release", "9", "完了", "--repo", "acme/other");
      expect(f.comments[9]).toBeUndefined();
      expect((await f.ghCalls()).some((c) => c.includes("-X POST repos/acme/other/issues/9/comments"))).toBe(true);
    } finally { f.done(); }
  });

  test("overlap has the app import first, and says so when GitHub cannot be reached", async () => {
    const f = fakes();
    try {
      expect(await f.guard("overlap", "40")).toBe(0);
      expect(f.synced()).toBe(1);
      expect(f.stderr()).toBe("");
    } finally { f.done(); }
    const off = fakes(424);
    try {
      expect(await off.guard("overlap", "40")).toBe(0);
      expect(off.stderr()).toContain("GitHub 未同期");
    } finally { off.done(); }
  });

  test("the holder stays the same after the app sends the comments", async () => {
    let seq = 0;
    const comments: Array<{ id: string; seq: number | null; body: string; createdAt: string }> = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace("http://app/api/backlog", "");
      const json = (body: unknown) => new Response(JSON.stringify(body));
      if (path === "/syncs") return json({ syncs: [{ workspaceId: "ws_g", repository: "acme/lib", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] });
      if (path.startsWith("/records")) return json({ workspaceId: "ws_g", service: "github" });
      if ((init.method ?? "GET") === "GET") return json({ comments });
      seq += 1;
      comments.push({ id: `local:${seq}`, seq, body: (JSON.parse(String(init.body)) as { text: string }).text, createdAt: `2026-09-28T11:00:0${seq}.000Z` });
      return json({ operation: "op" });
    }) as unknown as typeof globalThis.fetch;
    const board = appBoard({ BACKLOG_URL: "http://app/api/backlog" }, fetch, "acme/lib");
    const first = await claim(board, 7, false);
    expect(first.held).toBe(true);
    comments.push({ id: "local:rival", seq: ++seq, body: "<!-- pbi-complete:claim rival -->", createdAt: "2026-09-28T11:00:09.000Z" }); // a claim that lost the race
    const before = holder(await board.comments(7));
    expect(before).toEqual(first.holder);
    // the first one sent later than the second: GitHub's node id and a later time; the seq stays
    comments[0] = { ...comments[0]!, id: "IC_kwDO", createdAt: "2026-09-28T12:00:00Z" };
    comments[1] = { ...comments[1]!, id: "IC_kwDN", createdAt: "2026-09-28T11:59:00Z" };
    expect(holder(await board.comments(7))).toEqual(before);
    // a mark only imported has no seq and comes before those written here
    comments.push({ id: "IC_old", seq: null, body: "<!-- pbi-complete:claim imported -->", createdAt: "2026-09-28T12:30:00Z" });
    expect(holder(await board.comments(7))?.token).toBe("imported");
  });

  test("an app that cannot be reached stops with exit 2 and gh writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-synced-"));
    try {
      const called = `${dir}/gh-called`;
      writeFileSync(`${dir}/gh`, `#!/bin/sh\ntouch ${called}\nexit 1\n`, { mode: 0o755 });
      const r = Bun.spawnSync([process.execPath, `${import.meta.dir}/parallel-guard.ts`, "claim", "1", "--repo", "acme/lib"], {
        cwd: import.meta.dir,
        env: { PATH: `${dir}:${process.env.PATH}`, BACKLOG_URL: "http://127.0.0.1:9/api/backlog", HOME: process.env.HOME ?? dir },
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("判定できなかった");
      expect(existsSync(called)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a local Task's PR links by Backlog-Task without a closing keyword", () => {
  expect(linkedIssues({ body: "## 概要\nBacklog-Task: 12\n本文", headRefName: "feat/x" })).toEqual([12]);
  expect(linkedIssues({ body: "Backlog-Task: 12", headRefName: "sb/12-x" })).toEqual([12, 12]);
  // only its own line: a mention in a sentence is not a link, and the GitHub forms are unchanged
  expect(linkedIssues({ body: "see Backlog-Task: 9 above", headRefName: null })).toEqual([]);
  expect(linkedIssues({ body: "Closes #3", headRefName: null })).toEqual([3]);
});

describe("parallel-guard shared files", () => {
  const server = "packages/core/src/server.ts";
  const asks = "packages/core/src/asks.ts";
  const other = (paths: string[]): Work => ({ ref: "Task #60", task: 60, paths, updatedAt: fresh });

  test("without a list every overlap holds, as before", () => {
    expect(judge({ paths: [server] }, [other([server])], now)).toEqual({ verdict: "defer", blocking: [{ ref: "Task #60", path: server, updatedAt: fresh }], stale: [] });
    expect(judge({ paths: [server] }, [other([server])], now, [])).toEqual(judge({ paths: [server] }, [other([server])], now));
  });

  test("an overlap only on a shared file goes and is reported; another file overlapping too defers, on that file alone", () => {
    expect(judge({ paths: [server] }, [other([server])], now, [server])).toEqual({ verdict: "go", blocking: [], stale: [], shared: [{ ref: "Task #60", path: server, updatedAt: fresh }] });
    const v = judge({ paths: [server, asks] }, [other([server, asks])], now, [server]);
    expect(v.verdict).toBe("defer");
    expect(v.blocking.map((h) => h.path)).toEqual([asks]);
    expect(v.shared!.map((h) => h.path)).toEqual([server]);
    // the other side names the directory: what both touch is still the shared file
    expect(judge({ paths: [server] }, [other(["packages/core/src/"])], now, [server]).verdict).toBe("go");
    expect(judge({ paths: ["packages/core/src/"] }, [other(["packages/core/src/"])], now, [server]).verdict).toBe("defer");
    // my directory meets the other's shared file and another file under it: the second one still holds
    const dir = judge({ paths: ["packages/core/src/"] }, [other([server, asks])], now, [server]);
    expect([dir.verdict, dir.blocking.map((h) => h.path), dir.shared!.map((h) => h.path)]).toEqual(["defer", [asks], [server]]);
  });

  test("the guard's verdict from the stored records carries the app's list", async () => {
    const issue = (n: number, over: Partial<StoredRecords["issues"][number]> = {}): StoredRecords["issues"][number] => ({ number: n, title: "", url: "", state: "OPEN", stateReason: null, body: "", labels: ["type:task"], parent: null, subIssues: [], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null, ...over });
    const r = (shared?: string[]): StoredRecords => ({ workspaceId: "w", service: "github", repository: REPO, project: { owner: "example", number: 8 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], unread: [], pulls: [], comments: [], ...(shared ? { shared } : {}),
      issues: [issue(40, { body: `\`${server}\`` }), issue(60, { body: `\`${server}\``, fields: { Status: "In progress" } })] });
    const run = (x: StoredRecords) => overlap({ ...ghBoard(REPO, github({ bodies: {} }).run), material: async () => storedMaterial(x, 40) }, 40, false, now);
    expect(await run(r([server]))).toMatchObject({ verdict: "go", blocking: [], shared: [{ ref: "Task #60", path: server }] });
    expect((await run(r())).verdict).toBe("defer");
  });
});

describe("parallel-guard overlap turn", () => {
  const a = "`packages/core/src/a.ts`";
  const issue = (n: number, over: Partial<StoredRecords["issues"][number]> = {}): StoredRecords["issues"][number] => ({ number: n, title: "", url: "", state: "OPEN", stateReason: null, body: "", labels: ["type:task"], parent: null, subIssues: [], createdAt: fresh, updatedAt: fresh, closedAt: null, fields: null, ...over });
  // P (`#20`, Task 21) yielded first and holds the path; Y (`#30`, Task 31) came later
  const records = (turns: StoredRecords["turns"]): StoredRecords => ({ workspaceId: "w", service: "github", repository: REPO, project: { owner: "example", number: 8 }, fetchedAt: 1, top: [{ name: "packages", dir: true }], unread: [], pulls: [], comments: [], turns,
    issues: [issue(20, { labels: ["type:pbi"], subIssues: [21] }), issue(21, { parent: 20, body: a }), issue(30, { labels: ["type:pbi"], subIssues: [31] }), issue(31, { parent: 30, body: a })] });
  const first = { pbi: 20, since: "2026-09-20T00:00:00Z", task: 21, paths: ["packages/core/src/a.ts"] };
  const run = (r: StoredRecords, task: number, claimed: boolean) => {
    const g = github({ bodies: {} });
    return overlap({ ...ghBoard(REPO, g.run), material: async () => storedMaterial(r, task) }, task, claimed, now).then((v) => ({ v, g }));
  };

  test("a Task of a PBI that is not first in the turn yields, even after claiming and however old the place is; the first one goes", async () => {
    const r = records([first]);
    for (const claimed of [false, true]) {
      const { v, g } = await run(r, 31, claimed);
      expect(v.verdict).toBe("defer");
      expect(v.blocking).toEqual([{ ref: "Task #21", path: "packages/core/src/a.ts", updatedAt: first.since, turn: 20 }]);
      expect(v.conditions).toEqual([{ key: "issue#21", value: "open", met: false }]);
      expect(g.comments[31] ?? []).toHaveLength(0); // the claim is taken back
    }
    expect((await run(r, 21, true)).v.verdict).toBe("go");
    // no place kept: as before
    expect((await run(records([]), 31, true)).v.verdict).toBe("go");
  });

  test("of two PBIs that both yielded, the earlier goes and the later yields", async () => {
    const r = records([first, { pbi: 30, since: "2026-09-21T00:00:00Z", task: 31, paths: ["packages/core/src/a.ts"] }]);
    expect((await run(r, 21, true)).v.verdict).toBe("go");
    expect((await run(r, 31, true)).v.blocking.map((h) => h.turn)).toEqual([20]);
  });
});
