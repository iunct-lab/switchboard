// test-reads: docs/design/schedule-samples.md ops-kit/src/secrets.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSecrets } from "../../../ops-kit/src/secrets.ts";
import { Db, SAMPLES_BEFORE_THE_LIST } from "./db.ts";
import { addSamples, ensureSecretScan, PROVISIONED_KEY, SAMPLE_TITLE_PREFIX, SAMPLES_DOC, SAMPLES_KEY, SCHEDULE_SAMPLES, type ScheduleSample } from "./scheduleSamples.ts";
import { Scheduler } from "./scheduler.ts";
import { TaskManager } from "./tasks/manager.ts";

let home: string;
let db: Db;
let scheduler: Scheduler;
let metaId: string;
const managers: TaskManager[] = [];
const newScheduler = () => {
  const tasks = new TaskManager(db, new Map(), () => undefined, { idleMs: 0 });
  managers.push(tasks);
  return new Scheduler(db, tasks);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-samples-"));
  db = new Db(join(home, "db.sqlite"));
  mkdirSync(join(home, "meta"));
  metaId = db.upsertWorkspace({ name: "meta", path: join(home, "meta"), kind: "meta" }).id;
  scheduler = newScheduler();
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const ONE: ScheduleSample[] = [{ id: "one", title: "一つ目", cron: "0 9 1 * *", runner: "claude", prompt: "一つ目をしてください。" }];
const TWO: ScheduleSample[] = [...ONE, { id: "two", title: "二つ目", cron: "0 9 2 * *", runner: "codex", prompt: "二つ目をしてください。" }];

test("samples: each is added once to the workspace, disabled, as a prompt schedule with （サンプル） at the head of its title", () => {
  const added = addSamples(db, scheduler, metaId, TWO);
  expect(added.map((s) => ({ title: s.title, enabled: s.enabled, action: s.action, runner: s.runner, workspaceId: s.workspaceId, prompt: s.prompt, cron: s.cron }))).toEqual([
    { title: "（サンプル）一つ目", enabled: false, action: "prompt", runner: "claude", workspaceId: metaId, prompt: "一つ目をしてください。", cron: "0 9 1 * *" },
    { title: "（サンプル）二つ目", enabled: false, action: "prompt", runner: "codex", workspaceId: metaId, prompt: "二つ目をしてください。", cron: "0 9 2 * *" },
  ]);
  expect(db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual(["one", "two"]);
  expect(addSamples(db, scheduler, metaId, TWO)).toEqual([]);
  expect(scheduler.list()).toHaveLength(2);
});

test("samples: one the person deleted is not put back, and a sample added to the list later is the only one the next call adds", () => {
  const [first] = addSamples(db, scheduler, metaId, ONE);
  scheduler.remove(first!.id);
  expect(addSamples(db, scheduler, metaId, ONE)).toEqual([]);
  expect(scheduler.list()).toHaveLength(0);
  expect(addSamples(db, scheduler, metaId, TWO).map((s) => s.title)).toEqual(["（サンプル）二つ目"]);
  expect(scheduler.list()).toHaveLength(1);
});

test("samples: one that cannot be added is not recorded, so the next call tries it again; the others are in", () => {
  const bad: ScheduleSample[] = [{ ...ONE[0]!, cron: "not a cron" }, TWO[1]!];
  expect(addSamples(db, scheduler, metaId, bad).map((s) => s.title)).toEqual(["（サンプル）二つ目"]);
  expect(db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual(["two"]);
  expect(addSamples(db, scheduler, metaId, TWO).map((s) => s.title)).toEqual(["（サンプル）一つ目"]);
});

test("samples: the list is the monthly check and the ten general ones, with ids and titles of their own", () => {
  expect(SCHEDULE_SAMPLES.map((s) => s.title)).toEqual([
    "床・天井・壁の点検", "評価の週報", "レビュー指摘の傾向", "動向からの案", "依存の更新", "公開リポジトリへの同期",
    "止まった理由", "バックログの棚卸し", "定期実行の見直し", "ルーブリックの校正", "AWS の費用の週報",
  ]);
  expect(new Set(SCHEDULE_SAMPLES.map((s) => s.id)).size).toBe(SCHEDULE_SAMPLES.length);
  const added = addSamples(db, scheduler, metaId);
  expect(added).toHaveLength(11);
  expect(added.every((s) => !s.enabled && s.title.startsWith(SAMPLE_TITLE_PREFIX) && s.action === "prompt")).toBe(true);
});

test("samples: no prompt holds a value of one instance (workspace id, repository owner, port, home path) or a secret", () => {
  for (const s of SCHEDULE_SAMPLES) {
    expect(s.prompt).not.toMatch(/ws_[0-9a-f]|iunct-lab|47831|localhost|127\.0\.0\.1|~\/\.switchboard|\/home\//);
    expect(findSecrets(s.prompt)).toEqual([]);
    expect(s.prompt.length).toBeLessThan(500);
  }
});

test("samples: the section a prompt names is a heading of the samples' document, and so are the two common sections", () => {
  const doc = readFileSync(join(import.meta.dir, "../../..", SAMPLES_DOC), "utf8");
  const headings = new Set([...doc.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]!));
  const named = SCHEDULE_SAMPLES.filter((s) => s.section);
  expect(named).toHaveLength(10);
  for (const s of named) {
    expect(headings.has(s.section!)).toBe(true);
    expect(s.prompt).toContain(`「${s.section}」`);
    expect(s.prompt).toContain(SAMPLES_DOC);
  }
  for (const common of ["How a sample reads the instance", "Where a sample files its request"]) {
    expect(headings.has(common)).toBe(true);
    for (const s of named) expect(s.prompt).toContain(`「${common}」`);
  }
  expect(doc).not.toMatch(/ws_[0-9a-f]{6}|iunct-lab|47831/);
});

test("samples: an instance from before the list (the old flag in its settings) is recorded as holding every sample of that time, and gets none", () => {
  db.setSetting("uiLayers.seeded", true);
  const file = join(home, "db.sqlite");
  db.close();
  db = new Db(file); // the migration reads the flag and leaves it: a release rolled back to would seed the monthly check again without it
  expect(db.getSetting<unknown>("uiLayers.seeded", null)).toBe(true);
  expect(db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual([...SAMPLES_BEFORE_THE_LIST]);
  expect(SAMPLES_BEFORE_THE_LIST).toEqual(SCHEDULE_SAMPLES.slice(0, SAMPLES_BEFORE_THE_LIST.length).map((s) => s.id));
  scheduler = newScheduler();
  expect(addSamples(db, scheduler, metaId, SCHEDULE_SAMPLES.slice(0, SAMPLES_BEFORE_THE_LIST.length))).toEqual([]);
  // a sample the list gets later goes in here as on any instance; a second open changes nothing
  expect(addSamples(db, scheduler, metaId, [...SCHEDULE_SAMPLES, ...ONE]).map((s) => s.title)).toEqual(["（サンプル）一つ目"]);
  db.close();
  db = new Db(file);
  expect(db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual([...SAMPLES_BEFORE_THE_LIST, "one"]);
  expect(db.getSetting<unknown>("uiLayers.seeded", null)).toBe(true);
});

/** Makes the first `setSetting` of `key` throw, as a disk error at the record would. */
function failRecordOnce(key: string) {
  const real = db.setSetting.bind(db);
  let thrown = false;
  db.setSetting = (k: string, v: unknown) => {
    if (k === key && !thrown) {
      thrown = true;
      throw new Error("disk I/O error");
    }
    return real(k, v);
  };
}

test("addSamples: a failure to record a sample's id leaves no row, and the next call adds each sample once", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    failRecordOnce(SAMPLES_KEY);
    expect(addSamples(db, scheduler, metaId, ONE)).toEqual([]);
  } finally {
    console.warn = warn;
  }
  expect(scheduler.list()).toHaveLength(0);
  expect(db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual([]);
  expect(addSamples(db, scheduler, metaId, TWO).map((s) => s.title)).toEqual(["（サンプル）一つ目", "（サンプル）二つ目"]);
  expect(addSamples(db, scheduler, metaId, TWO)).toEqual([]);
  expect(scheduler.list()).toHaveLength(2);
});

test("ensureSecretScan: a failure to record leaves no row, and the next call adds one scan and records it", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    failRecordOnce(PROVISIONED_KEY);
    expect(ensureSecretScan(db, scheduler, metaId)).toBeNull();
  } finally {
    console.warn = warn;
  }
  expect(scheduler.list()).toHaveLength(0);
  expect(db.getSetting<string[]>(PROVISIONED_KEY, [])).toEqual([]);
  expect(ensureSecretScan(db, scheduler, metaId)?.action).toBe("secret-scan");
  expect(db.getSetting<string[]>(PROVISIONED_KEY, [])).toEqual(["secret-scan"]);
  expect(ensureSecretScan(db, scheduler, metaId)).toBeNull();
  expect(scheduler.list().filter((s) => s.action === "secret-scan")).toHaveLength(1);
});
