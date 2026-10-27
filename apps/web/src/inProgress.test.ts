import { describe, expect, test } from "bun:test";
import type { BacklogItem, Schedule, Workspace } from "@switchboard/protocol";
import { activeTaskLine, ago, autoByWorkspace, inProgressState, lastTaskLine, taskTimes, overlapLine, prereqLine, waitChain, waitOwner, waitRef, waitText, waitUrl } from "./inProgress.ts";

const item = (over: Partial<BacklogItem>): BacklogItem => ({
  number: 1, title: "t", url: "u", type: "pbi", stage: "in-progress", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  tasks: { total: 3, done: 1, doneAt: null }, decision: null, activeTaskId: null, projectStatus: "In progress", lastTask: null, report: null, answeredAt: null, heldAt: null, confirmations: [], closable: false, waits: [], waitsAt: null, overlap: null, prereqs: [], stopSummary: [], mockupTask: null, mockups: [], workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});
const last = (status: NonNullable<BacklogItem["lastTask"]>["status"]) => ({ id: "task_1", status, updatedAt: 0 });

test("inProgressState: running / all Tasks done / last failed / no stage Task / last finished", () => {
  // a running stage Task wins over everything else
  expect(inProgressState(item({ activeTaskId: "task_1", tasks: { total: 2, done: 2, doneAt: null }, lastTask: last("running") }))).toEqual({ running: true, label: "動いている" });
  expect(inProgressState(item({ lastTask: last("waiting") }))).toEqual({ running: true, label: "動いている" });
  expect(inProgressState(item({ tasks: { total: 2, done: 2, doneAt: null }, lastTask: last("error") }))).toEqual({ running: false, label: "止まっている: Task は全部完了、PBI は開いたまま" });
  // no sub-issues at all is not "all done"
  expect(inProgressState(item({ tasks: { total: 0, done: 0, doneAt: null }, lastTask: last("error") })).label).toBe("止まっている: 最後の工程 Task が失敗");
  expect(inProgressState(item({ lastTask: last("error") })).label).toBe("止まっている: 最後の工程 Task が失敗");
  expect(inProgressState(item({ lastTask: null })).label).toBe("止まっている: 工程 Task なし");
  expect(inProgressState(item({ lastTask: last("done") })).label).toBe("止まっている: 最後の工程 Task は完了");
  expect(inProgressState(item({ lastTask: last("aborted") })).label).toBe("止まっている: 最後の工程 Task は中断");
  expect(inProgressState(item({ lastTask: last("idle") })).label).toBe("止まっている: 最後の工程 Task は未開始");
  expect(inProgressState(item({ lastTask: last("done") })).running).toBe(false);
});

test("ago: minutes, hours, days", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  expect(ago("2026-09-29T11:59:30Z", now)).toBe("0 分前");
  expect(ago(now - 59 * 60_000, now)).toBe("59 分前");
  expect(ago(now - 60 * 60_000, now)).toBe("1 時間前");
  expect(ago("2026-09-28T12:00:01Z", now)).toBe("23 時間前");
  expect(ago("2026-09-28T12:00:00Z", now)).toBe("1 日前");
  expect(ago("2026-09-12T07:00:00Z", now)).toBe("17 日前");
  // a clock a little behind the server's is not "in the future"
  expect(ago(now + 5_000, now)).toBe("0 分前");
});

const wait = (number: number, kind: "issue" | "pr", open: boolean | null, reason: "overlap" | "prerequisite" = "prerequisite", pbi: number | null = null) =>
  ({ number, kind, open, state: open === null ? ("missing" as const) : open ? ("pending" as const) : ("met" as const), reason, pbi: pbi === null ? null : { number: pbi, title: null } });

test("waitText: nothing / one open / all closed / one not read; the condition by reason; whether backlog-next goes on by itself", () => {
  expect(waitText(item({}), true)).toBeNull();
  // a record whose waits all left (deferred PRs): 待ちが解けた, as backlog-next takes it
  expect(waitText(item({ waits: [], waitsAt: "2026-10-01T00:00:00Z" }), true)).toEqual({ label: "待ちが解けた", done: true, cond: "", next: "次の定期実行で再開" });
  expect(waitText(item({ waitsAt: "2026-10-01T00:00:00Z", waits: [wait(778, "pr", true, "overlap"), wait(603, "issue", false, "overlap")] }), true)).toEqual({ label: "待ち", done: false, cond: "相手が閉じてファイルの重なりが解けたら", next: "次の定期実行で再開" });
  expect(waitText(item({ waitsAt: "2026-10-01T00:00:00Z", waits: [wait(603, "issue", false)] }), true)).toEqual({ label: "待ちが解けた", done: true, cond: "前提が完了したら", next: "次の定期実行で再開" });
  // not read is not closed
  expect(waitText(item({ waitsAt: "2026-10-01T00:00:00Z", waits: [wait(603, "issue", false), wait(999, "issue", null)] }), false)).toEqual({ label: "待ち", done: false, cond: "前提が完了したら / 未取得の相手は状態が分からない", next: "定期実行は再開しない: 未取得の相手を確かめて/pbi-complete 1 を手で始める" });
  // the person's way by the row's stage: Ready has 実装する, in progress has no button that resumes it
  expect(waitText(item({ waitsAt: "2026-10-01T00:00:00Z", waits: [wait(603, "issue", false)] }), false)!.next).toBe("定期実行が無効: /pbi-complete 1 を手で始める");
  expect(waitText(item({ stage: "ready", waitsAt: "2026-10-01T00:00:00Z", waits: [wait(603, "issue", false)] }), false)!.next).toBe("定期実行が無効: 「実装する」で再開");
  expect(waitText(item({ stage: "ready", waitsAt: "2026-10-01T00:00:00Z", waits: [wait(999, "issue", null)] }), true)!.next).toBe("定期実行は再開しない: 未取得の相手を確かめて「実装する」で再開");
  expect(waitText(item({ waitsAt: "2026-10-01T00:00:00Z", waits: [wait(1, "pr", true, "overlap"), wait(2, "issue", true)] }), true)!.cond).toBe("相手が閉じてファイルの重なりが解けたら / 前提が完了したら");
});

test("waitRef / waitUrl: PR #n or #n with 開いている / 完了 / 未取得, linked in the row's repository", () => {
  expect(waitRef(wait(778, "pr", true))).toEqual({ ref: "PR #778", state: "開いている" });
  expect(waitRef(wait(603, "issue", false))).toEqual({ ref: "#603", state: "完了" });
  expect(waitRef(wait(999, "issue", null))).toEqual({ ref: "#999", state: "未取得" });
  const row = item({ url: "https://github.com/acme/app/issues/307" });
  expect(waitUrl(row, wait(778, "pr", true))).toBe("https://github.com/acme/app/pull/778");
  expect(waitUrl(row, wait(603, "issue", true))).toBe("https://github.com/acme/app/issues/603");
});

test("waitChain: one step, two steps, a cycle, a parent not known; closed waits and PRs are not followed", () => {
  const a = item({ number: 10, waits: [wait(101, "issue", true, "prerequisite", 20), wait(778, "pr", true), wait(102, "issue", false, "prerequisite", 30)] });
  const b = item({ number: 20, waits: [wait(201, "issue", true, "overlap", 40)] });
  const c = item({ number: 30, waits: [wait(301, "pr", true)] });
  const d = item({ number: 40, waits: [wait(401, "issue", true, "prerequisite", 10)] });
  // one step: #101's parent #20 waits (its own waits next), the PR and the closed #102 are not followed
  expect(waitChain(a, [a, b, c]).map((s) => [s.depth, s.via.number, s.parent?.number ?? null])).toEqual([[0, 101, 20], [1, 201, null]]);
  // two steps, then back to #10: the cycle stops
  expect(waitChain(a, [a, b, c, d]).map((s) => [s.depth, s.via.number, s.parent?.number ?? null])).toEqual([[0, 101, 20], [1, 201, 40]]);
  // no parent, or one not in the list: 先は未取得; one not read is not followed (the row says 未取得 already)
  expect(waitChain(item({ waits: [wait(5, "issue", true)] }), []).map((s) => s.parent)).toEqual([null]);
  expect(waitChain(item({ waits: [wait(5, "issue", null)] }), [])).toEqual([]);
  // a wait on a PBI itself (its `pbi` is its own number) is not followed into that PBI's waits: one step only (#937)
  expect(waitChain(item({ waits: [wait(20, "issue", true, "prerequisite", 20)] }), [b]).map((s) => s.parent)).toEqual([null]);
  // a parent in the list with nothing to wait for ends the chain
  expect(waitChain(a, [a, { ...b, waits: [] }])).toEqual([]);
  // another workspace's #20 is another PBI
  expect(waitChain(a, [{ ...b, workspaceId: "ws_other" }]).map((s) => s.parent)).toEqual([null]);
});

test("waitOwner: the PBI behind a wait and its stage Task, from the same list; 続きを始める only for a stopped Ready / in-progress PBI (#1045)", () => {
  const row = item({ number: 10, url: "https://github.com/acme/app/issues/10" });
  const w = wait(778, "pr", true, "overlap", 20);
  const pbi20 = { number: 20, title: "PBI 20", url: "https://github.com/acme/app/issues/20" };
  const owner = (over: Partial<BacklogItem>) => waitOwner(w, row, [row, item({ number: 20, title: "PBI 20", ...over })]);
  // not known: 不明
  expect(waitOwner(wait(778, "pr", true), row, [row])).toBeNull();
  // not in the list (closed): the PBI by its stored title, its Task not known, nothing to start
  expect(waitOwner(w, row, [row])).toEqual({ pbi: { ...pbi20, title: "" }, task: "unknown", startable: false });
  expect(owner({ activeTaskId: "task_run", lastTask: last("running") })).toEqual({ pbi: pbi20, task: { id: "task_run", running: true, label: "動いている" }, startable: false });
  // a last Task still running is moving even before activeTaskId says so
  expect(owner({ lastTask: last("waiting") })).toMatchObject({ task: { id: "task_1", running: true }, startable: false });
  expect(owner({ lastTask: last("done") })).toEqual({ pbi: pbi20, task: { id: "task_1", running: false, label: "止まっている: 完了" }, startable: true });
  expect(owner({ stage: "ready", lastTask: null })).toEqual({ pbi: pbi20, task: null, startable: true });
  // a closed wait still names its PBI and Task, with nothing to continue
  expect(waitOwner(wait(778, "pr", false, "overlap", 20), row, [row, item({ number: 20, title: "PBI 20", lastTask: last("done") })])).toEqual({ pbi: pbi20, task: { id: "task_1", running: false, label: "止まっている: 完了" }, startable: false });
  expect(owner({ stage: "needs-decision", lastTask: last("aborted") })).toMatchObject({ task: { label: "止まっている: 中断" }, startable: false });
  // another workspace's #20 is another PBI
  expect(waitOwner(w, row, [row, item({ number: 20, workspaceId: "ws_other", lastTask: last("done") })])).toMatchObject({ task: "unknown" });
});

test("waitText / waitRef: a wait withdrawn (#937) is 取り下げ, not 完了, and backlog-next does not go on by itself", () => {
  const withdrawn = { ...wait(778, "pr", null), state: "withdrawn" as const };
  expect(waitRef(withdrawn)).toEqual({ ref: "PR #778", state: "取り下げ" });
  const t = waitText(item({ stage: "ready", waitsAt: "2026-10-01T00:00:00Z", waits: [withdrawn, wait(13, "issue", false)] }), true)!;
  expect(t).toMatchObject({ label: "待ち", done: false, next: "定期実行は再開しない: 取り下げの相手を確かめて「実装する」で再開" });
  expect(t.cond).toContain("取り下げた相手は完了とみなさない");
});

test("prereqLine: 前提 for what is not done yet, 進められない for what a person fixes, the Task named; none for met", () => {
  const p = (number: number, kind: "issue" | "pr" | null, need: "done" | "merged" | "release", state: BacklogItem["prereqs"][number]["state"], via: number | null = null) => ({ number, kind, need, state, via });
  const text = (parts: ReturnType<typeof prereqLine>["waiting"]) => parts.map((x) => `${x.via !== null ? `Task #${x.via} の前提 ` : ""}${x.ref}${x.after}`).join("・");
  const line = prereqLine(item({ url: "https://github.com/o/r/issues/1", prereqs: [
    p(12, "issue", "done", "pending"), p(34, "pr", "merged", "pending"), p(56, "pr", "release", "pending", 70),
    p(13, "issue", "done", "withdrawn"), p(99, null, "done", "missing"), p(9, "issue", "done", "cycle"), p(57, "pr", "release", "unknown"), p(5, "issue", "done", "met"),
  ] }));
  expect(text(line.waiting)).toBe("#12（未完）・PR #34（マージ待ち）・Task #70 の前提 PR #56（リリース待ち）");
  expect(text(line.stuck)).toBe("#13 取り下げ・#99 見つからない・#9 と循環・PR #57 の反映を確かめられない");
  expect(line.waiting[1]!.url).toMatch(/\/pull\/34$/);
  expect(line.stuck[1]!.url).toMatch(/\/issues\/99$/);
  expect(line.waiting[2]!.viaUrl).toBe("https://github.com/o/r/issues/70");
  // waits recorded by a release stay in their own line
  expect(prereqLine(item({ waitsAt: "2026-10-01T00:00:00Z", waits: [wait(1, "pr", true, "overlap")] }))).toEqual({ waiting: [], stuck: [] });
});

test("waitText: a wait solved does not promise the next firing while a prerequisite still holds the row (#937)", () => {
  const solved = { stage: "ready" as const, waitsAt: "2026-10-01T00:00:00Z", waits: [wait(13, "issue", false)] };
  const pending = { number: 12, kind: "issue" as const, need: "done" as const, state: "pending" as const, via: null };
  expect(waitText(item({ ...solved, prereqs: [pending] }), true)!.next).toBe("前提が完了したら次の定期実行で再開");
  expect(waitText(item({ ...solved, prereqs: [{ ...pending, state: "withdrawn" }] }), true)!.next).toBe("定期実行は再開しない: 前提を確かめて「実装する」で再開");
  expect(waitText(item({ ...solved, prereqs: [{ ...pending, state: "met" }] }), true)!.next).toBe("次の定期実行で再開");
});

test("overlapLine: the PR / Task the row's files overlap with, each linked; why it cannot be judged; none otherwise (#1044)", () => {
  const url = "https://github.com/o/r/issues/1";
  expect(overlapLine(item({ url }))).toBeNull();
  expect(overlapLine(item({ url, overlap: { hits: [], unknown: null } }))).toBeNull();
  expect(overlapLine(item({ url, overlap: { hits: [{ ref: "PR #50", path: "src/a.ts" }, { ref: "Task #60", path: "src/b.ts" }], unknown: null } }))).toEqual({
    hits: [{ ref: "PR #50", url: "https://github.com/o/r/pull/50", path: "src/a.ts" }, { ref: "Task #60", url: "https://github.com/o/r/issues/60", path: "src/b.ts" }],
    unknown: null,
  });
  expect(overlapLine(item({ url, overlap: { hits: [], unknown: "PR #51 の変更ファイルが記録に無い" } }))).toEqual({ hits: [], unknown: "PR #51 の変更ファイルが記録に無い" });
});

describe("taskTimes (#2030)", () => {
  // run with TZ=UTC: the words are JST whatever the browser's zone
  const now = Date.parse("2026-10-19T09:00:00Z"); // 18:00 JST
  test("start and since, the clock alone on the same JST day", () => {
    expect(taskTimes({ status: "done", createdAt: Date.parse("2026-10-19T08:03:00Z"), statusAt: Date.parse("2026-10-19T08:40:00Z") }, now)).toEqual({ started: "開始 17:03", since: "17:40 から完了" });
  });
  test("another JST day carries the date; each status has its word", () => {
    expect(taskTimes({ status: "aborted", createdAt: Date.parse("2026-10-18T13:00:00Z"), statusAt: Date.parse("2026-10-18T14:10:00Z") }, now)).toEqual({ started: "開始 10/18 22:00", since: "10/18 23:10 から中断" });
    const at = Date.parse("2026-10-19T08:50:00Z");
    expect(taskTimes({ status: "running", createdAt: at - 3_600_000, statusAt: at }, now).since).toBe("17:50 から実行中");
    expect(taskTimes({ status: "waiting", createdAt: at, statusAt: at }, now).since).toBe("17:50 から承認待ち");
    expect(taskTimes({ status: "error", createdAt: at, statusAt: at }, now).since).toBe("17:50 からエラー"); // the Task screen's word, as its head and the rail say it
    expect(taskTimes({ status: "idle", createdAt: at, statusAt: at }, now).since).toBe("17:50 から待機");
    expect(taskTimes({ status: "idle", createdAt: at, statusAt: at }, now, "状態未確認").since).toBe("17:50 から状態未確認");
  });
  test("the Backlog row's last Task and its running button", () => {
    const t = { status: "aborted" as const, createdAt: Date.parse("2026-10-19T07:02:00Z"), statusAt: Date.parse("2026-10-19T08:40:00Z") };
    expect(lastTaskLine(t, now)).toBe("最後の Task: 中断（17:40 から・開始 16:02）");
    expect(activeTaskLine({ status: "running", statusAt: t.statusAt }, now)).toBe("実行中（17:40 から）");
    expect(activeTaskLine({ status: "waiting", statusAt: t.statusAt }, now)).toBe("承認待ち（17:40 から）");
    expect(activeTaskLine(null, now)).toBe("実行中");
  });
});

test("autoByWorkspace (#2656): a workspace at implement 0 is not moved by itself; a disabled schedule moves none", () => {
  const ws = (id: string, implement: number): Workspace => ({ id, name: id, path: `/w/${id}`, kind: "repo", createdAt: 0, backlog: "github", sweep: { implement, plan: 1 } });
  const schedule = (enabled: boolean) => ({ action: "backlog-next", enabled }) as Schedule;
  const workspaces = [ws("ws_meta", 2), ws("ws_lib", 0)];
  expect(autoByWorkspace([schedule(true)], workspaces)).toEqual({ ws_meta: true, ws_lib: false });
  expect(autoByWorkspace([schedule(false)], workspaces)).toEqual({ ws_meta: false, ws_lib: false });
  expect(autoByWorkspace([], workspaces)).toEqual({ ws_meta: false, ws_lib: false });
  // the row of the workspace at 0 does not say it resumes by itself; the other one does
  const auto = autoByWorkspace([schedule(true)], workspaces);
  const row = (workspaceId: string) => item({ workspaceId, stage: "ready", waitsAt: "2026-10-01T00:00:00Z", waits: [] });
  expect(waitText(row("ws_lib"), auto.ws_lib ?? false)!.next).not.toContain("次の定期実行で再開");
  expect(waitText(row("ws_meta"), auto.ws_meta ?? false)!.next).toBe("次の定期実行で再開");
});
