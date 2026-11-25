// test-reads: apps/web/src/components/Settings.tsx apps/web/src/components/ReviewJobCells.tsx
import { describe, expect, test } from "bun:test";
import { Settings } from "@switchboard/protocol";
import { RESETTABLE_CARDS, resetCard, type ResettableCard } from "./settingsDefaults.ts";
import { SETTINGS_GROUPS } from "./settingsGroups.ts";
import { settings } from "./i18n/settings.ts";
import { jobRows } from "./runnerSettings.ts";

const source = await Bun.file(new URL("./components/Settings.tsx", import.meta.url)).text();
/** The review's rows of 「どの仕事を」 save in their own component: what they save is the jobs card's. */
const reviewCells = await Bun.file(new URL("./components/ReviewJobCells.tsx", import.meta.url)).text();
const defaults = Settings.parse({});
const cards = Object.keys(RESETTABLE_CARDS) as ResettableCard[];

/** The folded cards of the screen by the key of their title: the source from the opening tag to the closing one. */
function drawnCards(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/<SettingsCard title=\{t\(settings\.(\w+)\)\}/g)) out[m[1]!] = source.slice(m.index, source.indexOf("</SettingsCard>", m.index));
  return out;
}

describe("RESETTABLE_CARDS", () => {
  test("every card that saves a setting has 既定に戻す, drawn the one way, and no other card has it", () => {
    const drawn = drawnCards();
    const saving = Object.entries(drawn).filter(([, src]) => /\bsave\(\{ ?\w+:|\bjobPatch\(/.test(src)).map(([key]) => key);
    // モデルの価格 is a list of rows the user added (each row has its own 消す), not a value with a default
    expect(saving.filter((k) => k !== "prices").sort()).toEqual([...cards].sort());
    for (const card of cards) expect({ card, reset: drawn[card]!.includes(`{reset.${card}}`) }).toEqual({ card, reset: true });
    // the button is drawn by `reset` (and by the block of one runner): no card builds its own patch
    expect([...source.matchAll(/<ResetButton\b/g)]).toHaveLength(2);
    expect(source).toContain("[card, <ResetButton key={card} disabled={saving} onClick={() => save(resetCard(card, d))} />]");
  });

  test("a card resets the keys it saves, a value is reset by one card only, and every card is one of the screen's list", () => {
    const drawn = drawnCards();
    for (const card of cards) {
      const src = card === "jobsCard" ? drawn[card]! + reviewCells : drawn[card]!;
      const saved = new Set([...src.matchAll(/\bsave\(\{ ?(\w+):/g)].map((m) => m[1]!));
      const reset = new Set(RESETTABLE_CARDS[card].map((p) => p.split(".")[0]!));
      for (const key of saved) expect({ card, key, reset: reset.has(key) }).toEqual({ card, key, reset: true });
    }
    const all = cards.flatMap((c) => RESETTABLE_CARDS[c]);
    expect(new Set(all).size).toBe(all.length);
    // a whole key and a value inside it are never both listed (the whole key would put the other card's value back too)
    for (const p of all.filter((x) => !x.includes("."))) expect(all.filter((x) => x.startsWith(`${p}.`))).toEqual([]);
    const titles = SETTINGS_GROUPS.flatMap((g) => g.sections);
    for (const card of cards) expect(titles).toContain(settings[card].ja);
  });

  test("every value listed has a default in the settings", () => {
    // recheckRunner has no default value: unset is its default (it follows the review setting), and null puts it back
    for (const path of cards.flatMap((c) => RESETTABLE_CARDS[c]).filter((p) => p !== "recheckRunner")) {
      const v = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], defaults);
      expect({ path, has: v !== undefined }).toEqual({ path, has: true });
    }
  });
});

describe("quotaAndResume", () => {
  test("every value of it is reset by some card, but the budgets of 予算 and of the kinds' rows", () => {
    const budgets = new Set(["fableBudgetUsd", "defaultBudgetUsd"]);
    const listed = new Set(cards.flatMap((c) => RESETTABLE_CARDS[c]).filter((p) => p.startsWith("quotaAndResume.")).map((p) => p.split(".")[1]!));
    const missing = Object.keys(defaults.quotaAndResume).filter((k) => !budgets.has(k) && !listed.has(k));
    expect(missing).toEqual([]);
  });
});

describe("the default shown next to a value", () => {
  test("each 「どの仕事を」 row shows the runner its row reads from the defaults", () => {
    // the recheck row says its own default: an unset recheck has no runner
    for (const r of jobRows(defaults, ["claude", "codex"]).filter((r) => r.id !== "recheck")) expect(r.runner).not.toBe("");
    expect(source).toContain("jobRows(d, reviewers).find((r) => r.id === j.id)?.runner");
  });
  test("the cap's box follows the saved value, and SweepSlots' own save of it reaches the screen's settings", () => {
    expect(source).toContain("flowLimit={qr.flowShareLimit}");
    expect(source).toContain("props.onSettings(await api.updateSettings({ quotaAndResume: { flowShareLimit: flow } }))");
    // compared with the saved value, not the allocation read when the card opened: after 既定に戻す that one is stale
    expect(source).toContain("flow !== props.flowLimit) props.onSettings(");
    expect(source).toContain("setFlowDraft(shareText(props.flowLimit))), [props.flowLimit]");
    expect(source).not.toMatch(/<SweepSlots key=/);
  });
});

describe("resetCard", () => {
  test("a whole key goes back by null", () => {
    expect(resetCard("release", defaults)).toEqual({ release: null });
    expect(resetCard("outbound", defaults)).toEqual({ outbound: null });
    expect(resetCard("sweep", defaults).maxRunners).toBeNull();
  });
  test("the self-improvement cap of 「バックログを進める」 goes back by its default, not by the whole key", () => {
    const sweep = resetCard("sweep", defaults);
    expect(sweep.quotaAndResume).toEqual({ flowShareLimit: defaults.quotaAndResume.flowShareLimit });
    expect(defaults.quotaAndResume.flowShareLimit).toBe(0.25);
  });
  test("a value inside a key goes back by its default, and the key's other values are not sent", () => {
    expect(resetCard("newSchedule", defaults)).toEqual({ newDefaults: { scheduleCron: defaults.newDefaults.scheduleCron } });
    expect(resetCard("budgetCard", defaults)).toEqual({ quotaAndResume: { fableBudgetUsd: defaults.quotaAndResume.fableBudgetUsd } });
    expect(resetCard("judgeAndChoice", defaults)).toEqual({
      judge: { enabled: defaults.judge.enabled },
      evals: { judge: { enabled: defaults.evals.judge.enabled } },
      judgeAndChoice: { judgeTimeoutMs: defaults.judgeAndChoice.judgeTimeoutMs, workspaceChoiceTimeoutMs: defaults.judgeAndChoice.workspaceChoiceTimeoutMs },
    });
    expect(resetCard("llm", defaults)).toEqual({ routing: { llm: { enabled: defaults.routing.llm.enabled, timeoutMs: defaults.routing.llm.timeoutMs } } });
    // 使用量と自動再開 leaves the budget and the flow limits of the same key alone
    const usage = resetCard("usage", defaults).quotaAndResume!;
    expect(Object.keys(usage)).not.toContain("fableBudgetUsd");
    expect(Object.keys(usage)).not.toContain("flowShareLimit");
    // every value the card shows with a default goes back, the three limits of a silent runner and of a wait too
    expect(usage).toMatchObject({ silentAfterMs: defaults.quotaAndResume.silentAfterMs, waitLimitMs: defaults.quotaAndResume.waitLimitMs, dependsLimitMs: defaults.quotaAndResume.dependsLimitMs });
  });
  test("the jobs card puts back every row's runner, model and effort", () => {
    const p = resetCard("jobsCard", defaults);
    expect(p.autoStart).toBeNull();
    expect(p.reviewRunner).toBeNull();
    expect(p.judge).toEqual({ runner: defaults.judge.runner, model: defaults.judge.model, effort: defaults.judge.effort });
    expect(p.newDefaults).toEqual({ taskRunner: defaults.newDefaults.taskRunner, taskModel: defaults.newDefaults.taskModel, taskEffort: defaults.newDefaults.taskEffort });
  });
});
