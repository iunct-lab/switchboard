import type { RunnerId, Schedule } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import type { Scheduler } from "./scheduler.ts";

/**
 * The schedule samples: prompt schedules a new instance gets from the start, disabled and with `（サンプル）` at the
 * head of the title. The person turns one on, rewrites it or deletes it in Schedules; the row is theirs from then on.
 * A sample is added once (its id goes into the setting `schedules.samples`), so one the person deleted does not come
 * back, and a sample added to this list later is the only one the next start adds. docs/design/scheduler.md, "Samples".
 *
 * A prompt holds no value of an instance (workspace id, repository name, port, account): the Task reads them from its
 * own environment, as docs/design/schedule-samples.md ("How a sample reads the instance") says.
 */
export type ScheduleSample = {
  /** What `schedules.samples` records; never reused for another sample. */
  id: string;
  title: string;
  cron: string;
  runner: RunnerId;
  prompt: string;
  /** The heading of docs/design/schedule-samples.md the prompt names, when it names one. */
  section?: string;
};

export const SAMPLE_TITLE_PREFIX = "（サンプル）";
export const SAMPLES_KEY = "schedules.samples";
export const SAMPLES_DOC = "docs/design/schedule-samples.md";

/**
 * What the monthly check's prompt says: the steps are in docs/design/ui-layers.md, so the person edits the wording
 * and the runner in Schedules like any prompt schedule's.
 */
export const UI_LAYERS_CHECK_PROMPT = "床・天井・壁の月次の点検をしてください。手順は docs/design/ui-layers.md の「The monthly check」の節に従います。";

/** Where the Task finds the document: the sample may run on any workspace, the document is in the meta workspace's folder. */
const WHERE_THE_DOC_IS =
  "Switchboard のリポジトリは、`curl -s -H \"Authorization: Bearer $(cat \"$BACKLOG_TOKEN_FILE\")\" \"${BACKLOG_URL%/api/backlog}/api/workspaces\"` の `kind` が `meta` の workspace の `path` です。";
const SCOPE = {
  workspace: "対象はこの Task の workspace とそのリポジトリです。",
  all: "対象は API から読む全 workspace です。",
} as const;

/** The prompt of a sample whose steps are a section of the samples' document: short, and the same sentence for all. */
export function samplePrompt(title: string, section: string, scope: keyof typeof SCOPE): string {
  return `「${title}」を行ってください。手順は Switchboard のリポジトリの ${SAMPLES_DOC} の「${section}」の節と、同じ文書の「How a sample reads the instance」「Where a sample files its request」の節に従います。${WHERE_THE_DOC_IS}${SCOPE[scope]}`;
}

const fromDoc = (id: string, title: string, cron: string, section: string, scope: keyof typeof SCOPE): ScheduleSample => ({
  id,
  title,
  cron,
  runner: "claude",
  section,
  prompt: samplePrompt(title, section, scope),
});

export const SCHEDULE_SAMPLES: readonly ScheduleSample[] = [
  { id: "ui-layers-check", title: "床・天井・壁の点検", cron: "0 9 1 * *", runner: "claude", prompt: UI_LAYERS_CHECK_PROMPT },
  // one workspace: the person changes the workspace in Schedules and the sample works on that repository
  fromDoc("eval-weekly", "評価の週報", "0 19 * * 0", "Weekly eval report", "workspace"),
  fromDoc("review-trends", "レビュー指摘の傾向", "0 19 2 * *", "Review comment trends", "workspace"),
  fromDoc("upstream-ideas", "動向からの案", "0 19 * * 3", "Ideas from upstream changes", "workspace"),
  fromDoc("deps-update", "依存の更新", "0 19 * * 2", "Dependency updates", "workspace"),
  fromDoc("public-sync", "公開リポジトリへの同期", "0 4 * * *", "Public repository sync", "workspace"),
  // every workspace, or the instance
  fromDoc("stop-reasons", "止まった理由", "0 20 * * 1", "Why tasks stopped", "all"),
  fromDoc("backlog-inventory", "バックログの棚卸し", "0 20 * * 4", "Backlog inventory", "all"),
  fromDoc("schedule-review", "定期実行の見直し", "0 20 1 * *", "Schedule review", "all"),
  fromDoc("rubric-calibration", "ルーブリックの校正", "0 20 4 * *", "Rubric calibration", "all"),
  fromDoc("aws-cost-weekly", "AWS の費用の週報", "0 20 * * 5", "Weekly AWS cost report", "workspace"),
];

/**
 * Adds the samples the setting does not hold yet to `workspaceId`, disabled; returns the rows it added. Each id is
 * recorded in the same transaction as its row, so one that failed leaves neither and is tried again at the next start,
 * and the others are in.
 */
export function addSamples(db: Db, scheduler: Scheduler, workspaceId: string, samples: readonly ScheduleSample[] = SCHEDULE_SAMPLES): Schedule[] {
  const added: Schedule[] = [];
  const failed: string[] = [];
  for (const s of samples) {
    const have = db.getSetting<string[]>(SAMPLES_KEY, []);
    if (have.includes(s.id)) continue;
    try {
      // the row and its record are one write: a failure to record rolls the row back, so the next call does not add it twice
      added.push(
        db.sqlite.transaction(() => {
          const row = scheduler.create({ title: SAMPLE_TITLE_PREFIX + s.title, cron: s.cron, action: "prompt", prompt: s.prompt, runner: s.runner, workspaceId, enabled: false });
          db.setSetting(SAMPLES_KEY, [...have, s.id]);
          return row;
        })(),
      );
    } catch (e) {
      failed.push(`${s.id} (${String((e as Error).message ?? e)})`);
    }
  }
  if (failed.length) console.warn(`schedule samples: could not add ${failed.join(", ")}`);
  return added;
}

/** What the daemon puts in by itself besides the samples (ids, as `SAMPLES_KEY` records the samples): once each, so one the person deleted or turned off stays so. */
export const PROVISIONED_KEY = "schedules.provisioned";
export const SECRET_SCAN = { id: "secret-scan", title: "認証の値の検査", cron: "30 3 * * *" } as const;

/**
 * The daily credential scan is there without anyone making it: outside the daemon, what was already written to Issues
 * and PRs is read only by the weekly workflow, and only where the repository's Actions are switched on, so an instance
 * with no scan that fires could have none.
 * Once per instance (`PROVISIONED_KEY`), at the first start that has a meta workspace:
 * - no secret-scan schedule is enabled (none at all, or only ones turned off) → one is added on meta, **enabled**;
 *   the rows already there are left as they are;
 * - one is enabled → nothing is added.
 * Either way the id is recorded, and no later start adds one: a schedule the person deletes or turns off after that is
 * not put back. What the record cannot tell is a scan deleted before it existed (an instance from before this record
 * looks the same as one that never had a scan): that instance gets the schedule once, and deleting it again holds.
 * Returns the row it added, or null.
 */
export function ensureSecretScan(db: Db, scheduler: Scheduler, workspaceId: string): Schedule | null {
  const have = db.getSetting<string[]>(PROVISIONED_KEY, []);
  if (have.includes(SECRET_SCAN.id)) return null;
  // an enabled scan already there: nothing to add, only the record
  if (db.listSchedules().some((s) => s.action === "secret-scan" && s.enabled)) {
    db.setSetting(PROVISIONED_KEY, [...have, SECRET_SCAN.id]);
    return null;
  }
  try {
    // the row and its record are one write: a failure of either leaves neither, so the next start adds one scan
    return db.sqlite.transaction(() => {
      const row = scheduler.create({ title: SECRET_SCAN.title, cron: SECRET_SCAN.cron, action: "secret-scan", runner: "claude", workspaceId, enabled: true });
      db.setSetting(PROVISIONED_KEY, [...have, SECRET_SCAN.id]);
      return row;
    })();
  } catch (e) {
    // not recorded: tried again at the next start (the meta folder is missing, or the record failed)
    console.warn(`secret scan: could not add the schedule (${String((e as Error).message ?? e)})`);
    return null;
  }
}
