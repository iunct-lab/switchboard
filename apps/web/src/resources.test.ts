import { expect, test } from "bun:test";
import type { OpsJob, OpsResources, ResourceRun, ResourceWait } from "@switchboard/protocol";
import { atLabel, consumerRows, etaLine, jobRow, latestAnswer, memoryLine, runOwner, since, typicalLabel, verdictLabel, waitLine, watchResources } from "./resources.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const memory: NonNullable<OpsResources["memory"]> = { availableBytes: 1 * GB, totalBytes: 3.7 * GB, swapUsedBytes: 1.1 * GB, floorBytes: 1.5 * GB };
const run = (o: Partial<ResourceRun>): ResourceRun => ({ pid: 1, name: "local-ci 3320", cwd: "/w", taskId: "t1", taskTitle: "キャッシュの読みを直す", queuedAt: "2026-11-03T10:00:00Z", startedAt: "2026-11-03T10:00:00Z", typicalMs: null, samples: 0, verdict: "none", ...o });
const wait = (o: Partial<ResourceWait>): ResourceWait => ({ pid: 2, name: "review codex", cwd: "/w", taskId: "t2", taskTitle: "リソース画面の実装", queuedAt: "2026-11-03T10:05:00Z", reason: "slot", memoryOnly: false, typicalMs: null, samples: 0, ...o });

test("resources: a slot wait names the holder's Task and run, a memory wait the free memory and the floor", () => {
  expect(waitLine(wait({}), [run({})], memory)).toBe("枠: キャッシュの読みを直す の local-ci 3320");
  expect(waitLine(wait({}), [run({}), run({ taskId: null, taskTitle: null, name: "bun test" })], memory)).toBe("枠: キャッシュの読みを直す の local-ci 3320、Task の外 の bun test");
  expect(waitLine(wait({}), [run({ taskId: "t_gone", taskTitle: null })], memory)).toBe("枠: Task t_gone の local-ci 3320"); // a Task this daemon does not know
  expect(waitLine(wait({}), [], memory)).toBe("枠（持ち主は終わったところ）");
  expect(waitLine(wait({ reason: "memory" }), [], memory)).toBe("空きメモリ 1.0 GB < 下限 1.5 GB");
  expect(waitLine(wait({ reason: "memory" }), [], null)).toBe("空きメモリ（下限未満）");
  expect(waitLine(wait({ reason: "memory" }), [], { ...memory, availableBytes: 2 * GB })).toBe("空きメモリ 2.0 GB（下限 1.5 GB を超えた。次の見回りで枠を見る）"); // read after the free memory rose, before the kit looks again
  expect(waitLine(wait({ reason: "memory", memoryOnly: true }), [run({})], memory)).toBe("メモリ（枠なし）"); // a run that takes no slot waits for the memory only
  expect(runOwner({ taskId: null, taskTitle: null })).toBe("Task の外");
});

test("resources: the free-memory line, below the floor or not, and none where the host cannot say", () => {
  expect(memoryLine(memory)).toEqual({ free: "1.0 GB", floor: "1.5 GB", below: true, usedRatio: 1 - 1 / 3.7, detail: "全体 3.7 GB · スワップ 1.1 GB 使用" });
  expect(memoryLine({ ...memory, availableBytes: 2 * GB })!.below).toBe(false);
  expect(memoryLine(null)).toBeNull();
});

test("resources: how long, and the minute the memory rows are from", () => {
  const t0 = Date.parse("2026-11-03T10:00:00Z");
  expect(since("2026-11-03T10:00:00Z", t0 + 45_000)).toBe("45 秒");
  expect(since("2026-11-03T10:00:00Z", t0 + 12 * 60_000 + 5_000)).toBe("12 分");
  expect(since("2026-11-03T10:00:00Z", t0 + 65 * 60_000)).toBe("1 時間 5 分");
  expect(since("2026-11-03T10:00:00Z", t0 - 1000)).toBe("0 秒"); // a clock a little behind the daemon's
  const at = new Date(2026, 10, 3, 15, 31).getTime();
  expect(atLabel(at)).toBe("15:31 時点");
});

test("resources: the memory rows link a Task and name the daemon and the rest", () => {
  const rows = consumerRows({
    at: 0,
    groups: [
      { taskId: "t1", taskTitle: "キャッシュの読みを直す", owner: "task", kind: "test", rssBytes: 1.2 * GB, procs: 4 },
      { taskId: null, taskTitle: null, owner: "daemon", kind: "other", rssBytes: 120 * MB, procs: 1 },
      { taskId: null, taskTitle: null, owner: "other", kind: "browser", rssBytes: 50 * MB, procs: 2 },
    ],
  });
  expect(rows.map((r) => [r.taskId, r.label, r.kind, r.rss, r.procs])).toEqual([
    ["t1", "キャッシュの読みを直す", "テスト / ローカル CI", "1.2 GB", 4],
    [null, "デーモン", "その他", "120 MB", 1],
    [null, "その他", "headless Chrome", "50 MB", 2],
  ]);
});

test("resources: polls only while visible", async () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" as DocumentVisibilityState });
  let reads = 0;
  const stop = watchResources(doc, () => reads++, 20);
  await Bun.sleep(60);
  expect(reads).toBe(0); // opened behind another tab: nothing
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(reads).toBe(1); // at once when it comes to the front
  for (const t0 = Date.now(); reads < 3 && Date.now() - t0 < 2000; ) await Bun.sleep(5);
  expect(reads).toBeGreaterThanOrEqual(3); // every interval while in front
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  const hidden = reads;
  await Bun.sleep(60);
  expect(reads).toBe(hidden);
  doc.visibilityState = "visible";
  stop(); // the screen closed
  const closed = reads;
  await Bun.sleep(60);
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(reads).toBe(closed);
  // opened in front: read at once, before the first interval
  let first = 0;
  watchResources(doc, () => first++, 10_000)();
  expect(first).toBe(1);
});

test("resources: an answer older than the one shown is dropped; slow answers that are each newer are all shown", () => {
  const o = latestAnswer();
  const [a, b, c] = [o.ask(), o.ask(), o.ask()]; // three reads out before any answer (each slower than 5 s)
  expect(o.take(a)).toBe(true); // the first answer is shown although newer reads are out
  expect(o.take(c)).toBe(true);
  expect(o.take(b)).toBe(false); // came after a newer one
  const d = o.ask();
  expect(o.take(d)).toBe(true);
});

test("resources: the usual time and the verdict of a run", () => {
  expect(typicalLabel(run({ typicalMs: 14 * 60_000, samples: 28 }))).toBe("14 分 · 28 件");
  expect(typicalLabel(wait({ typicalMs: 75 * 60_000, samples: 3 }))).toBe("1 時間 15 分 · 3 件");
  expect(typicalLabel(wait({ typicalMs: null, samples: 2 }))).toBe("実績なし"); // fewer than 3: no median
  expect(verdictLabel(run({ verdict: "none" }))).toBe("実績なし");
  expect(verdictLabel(run({ verdict: "normal" }))).toBe("普段どおり");
  expect(verdictLabel(run({ verdict: "long" }))).toBe("普段の 2 倍より長い");
});

test("resources: eta line", () => {
  expect(etaLine({ etaMs: 38 * 60_000, unknown: 0 }, 2)).toEqual({ value: "約 38 分", note: null });
  expect(etaLine({ etaMs: 38 * 60_000, unknown: 1 }, 3)).toEqual({ value: "約 38 分", note: "実績の無い 1 件を除く" });
  expect(etaLine({ etaMs: 20_000, unknown: 0 }, 1)).toEqual({ value: "1 分以内", note: null });
  expect(etaLine({ etaMs: 0, unknown: 1 }, 2)).toEqual({ value: "1 分以内", note: "実績の無い 1 件を除く" }); // the known one is past its median
  expect(etaLine({ etaMs: 0, unknown: 3 }, 3)).toEqual({ value: "実績なし", note: "実績の無い 3 件" }); // nothing known: not 「1 分以内」
  expect(etaLine({ etaMs: null, unknown: 0 }, 0)).toEqual({ value: "待ちはありません", note: null }); // nothing running or waiting
});

test("resources: a job's row — its kind with the review's runner, its status in words, how long it ran or has run (#3995)", () => {
  const t0 = Date.parse("2026-11-06T10:00:00Z");
  const job = (o: Partial<OpsJob>): OpsJob => ({ id: 7, kind: "local-ci", taskId: "t1", taskTitle: "仕事の口", pr: 12, runner: null, status: "running", exitCode: null, startedAt: t0, endedAt: null, ...o });
  expect(jobRow(job({}), t0 + 125_000)).toEqual({ kind: "local-ci", status: "実行中", elapsed: "2 分" });
  expect(jobRow(job({ kind: "review", runner: "codex", status: "pass", exitCode: 0, endedAt: t0 + 45_000 }), t0 + 3600_000)).toEqual({ kind: "review (codex)", status: "成功", elapsed: "45 秒" });
  expect(jobRow(job({ status: "fail", exitCode: 1, endedAt: t0 + 3900_000 }), t0 + 9e9).status).toBe("失敗（終了コード 1）");
  expect(jobRow(job({ status: "aborted", endedAt: t0 + 1000 }), t0).status).toBe("中断");
});
