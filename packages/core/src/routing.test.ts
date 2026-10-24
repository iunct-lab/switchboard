import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoutingSuggestion } from "@switchboard/protocol";
import { CompositeSuggester, keywordHit, loadRoutingTable, MAX_LLM_REASON, RuleSuggester, ruleMatches, suggestRunner, type RoutingContext, type Suggester } from "./routing.ts";

const { table, source } = loadRoutingTable([join(import.meta.dir, "..", "config", "routing.yaml")]);
const base: RoutingContext = { title: "", prompt: "", scope: ["/repo"], available: new Set(["claude", "codex", "dak"]) };

describe("routing rule table", () => {
  test("the shipped routing.yaml parses and has the proposal's rules", () => {
    expect(source).toContain("routing.yaml");
    expect(table.rules.map((r) => r.id)).toEqual(["multi-repo", "design-research", "self-dev", "maintenance-routine", "single-repo-long"]);
  });

  test("multi-repo scope → claude, first match wins even if other rules also match", () => {
    const s = suggestRunner(table, { ...base, scope: ["/a", "/b"], prompt: "依存のトリアージ" });
    expect(s.runner).toBe("claude");
    expect(s.ruleId).toBe("multi-repo");
    expect(s.alternatives.map((a) => a.runner)).toEqual(["dak"]);
  });

  test("keywords are case-insensitive and searched in title and prompt", () => {
    expect(suggestRunner(table, { ...base, title: "PR Review", prompt: "" }).runner).toBe("codex");
    expect(suggestRunner(table, { ...base, prompt: "この設計を比較して" }).runner).toBe("claude");
    expect(suggestRunner(table, { ...base, prompt: "nightly の deps トリアージ" }).runner).toBe("dak");
  });

  test("an explicit kind qualifies without keywords and is authoritative over keywords", () => {
    expect(suggestRunner(table, { ...base, kind: "maintenance", prompt: "x" }).ruleId).toBe("maintenance-routine");
    expect(suggestRunner(table, { ...base, kind: "review", prompt: "x" }).runner).toBe("codex");
    // the user said "review": the dependency keywords must not re-route to dak
    expect(suggestRunner(table, { ...base, kind: "review", prompt: "依存のトリアージ" }).ruleId).toBe("single-repo-long");
  });

  test("ASCII keywords match on word boundaries; CJK keywords match as substrings", () => {
    expect(keywordHit(["format"], { title: "", prompt: "read the information" })).toBe(false);
    expect(keywordHit(["review"], { title: "preview overview", prompt: "" })).toBe(false);
    expect(keywordHit(["review"], { title: "PR review", prompt: "" })).toBe(true);
    expect(keywordHit(["fix all"], { title: "", prompt: "please fix all tests" })).toBe(true);
    expect(keywordHit(["設計"], { title: "", prompt: "この設計を比較" })).toBe(true);
    expect(suggestRunner(table, { ...base, prompt: "read the information about the platform" }).ruleId).toBe("fallback");
  });

  test("meta workspace → claude via self-dev", () => {
    expect(suggestRunner(table, { ...base, workspaceKind: "meta", prompt: "ボタンの色を変えて" }).ruleId).toBe("self-dev");
  });

  test("no match → previous runner in the workspace, else the fallback; missing runners are flagged", () => {
    const s = suggestRunner(table, { ...base, prompt: "typo を直して", previousRunner: "codex" });
    expect(s).toMatchObject({ runner: "codex", ruleId: "previous", available: true });
    const f = suggestRunner(table, { ...base, prompt: "typo を直して", available: new Set(["codex"]) });
    expect(f).toMatchObject({ runner: "claude", ruleId: "fallback", available: false });
  });

  test("ruleMatches: every specified condition must hold", () => {
    const rule = { id: "r", when: { minRepos: 2, keywords: ["x"] }, runner: "claude" as const, reason: "r" };
    expect(ruleMatches(rule, { ...base, scope: ["/a", "/b"], prompt: "x" })).toBe(true);
    expect(ruleMatches(rule, { ...base, scope: ["/a"], prompt: "x" })).toBe(false);
    expect(ruleMatches(rule, { ...base, scope: ["/a", "/b"], prompt: "y" })).toBe(false);
  });

  test("a missing or invalid user file falls back to the next path with the problem reported; no file at all yields an empty table", () => {
    expect(loadRoutingTable(["/nonexistent/routing.yaml", join(import.meta.dir, "..", "config", "routing.yaml")]).source).toContain("config");
    expect(loadRoutingTable(["/nonexistent/routing.yaml"]).table.rules).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "sb-routing-"));
    const bad = join(dir, "routing.yaml");
    writeFileSync(bad, "version: 1\nrules:\n  - id: typo\n    when: { keyword: [x] }\n    runner: dak\n    reason: r\n");
    const logs: string[] = [];
    const r = loadRoutingTable([bad, join(import.meta.dir, "..", "config", "routing.yaml")], (m) => logs.push(m));
    expect(r.source).toContain("config");
    expect(r.problems[0]).toContain("keyword");
    expect(logs).toHaveLength(1);
    writeFileSync(bad, "version: 1\nrules: [\n");
    expect(loadRoutingTable([bad], () => undefined).source).toBe("builtin");
  });

  test("trailing slashes do not make one directory count as two repos", () => {
    expect(suggestRunner(table, { ...base, scope: ["/repo", "/repo/"], prompt: "typo" }).ruleId).not.toBe("multi-repo");
  });
});

describe("CompositeSuggester (#25)", () => {
  const rule = new RuleSuggester(() => table);
  const ctx: RoutingContext = { ...base, title: "PR review", prompt: "" };
  const never = new AbortController().signal;
  const composite = (primary: Suggester, timeoutMs = 30) => new CompositeSuggester(primary, rule, timeoutMs, () => undefined);
  const answering = (answer: unknown, delayMs = 0): Suggester => ({
    async suggest() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return answer as RoutingSuggestion;
    },
  });

  test("the rule table decides and the primary's answer only rides along", async () => {
    const out = await composite(answering({ runner: "dak", reason: " ローカルで足りる " })).suggest(ctx, never);
    expect(out).toMatchObject({ runner: "codex", ruleId: "single-repo-long", llm: { runner: "dak", reason: "ローカルで足りる" } });
  });

  test("a primary that is late, throws, or throws synchronously falls back without an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (e: Event) => (e.preventDefault(), rejections.push((e as Event & { reason: unknown }).reason));
    addEventListener("unhandledrejection", onUnhandled);
    try {
      expect((await composite(answering({ runner: "dak", reason: "遅い" }, 300), 30).suggest(ctx, never)).llm).toBeNull();
      expect((await composite({ suggest: () => Promise.reject(new Error("runner said no")) }).suggest(ctx, never)).llm).toBeNull();
      // a non-async implementation can throw before it ever returns a promise (a missing binary: Bun.spawn ENOENT)
      const throwsSync: Suggester = { suggest: () => { throw new Error("ENOENT"); } };
      expect((await composite(throwsSync).suggest(ctx, never)).llm).toBeNull();
      // a primary that wins the race still leaves the internal deadline promise rejected
      expect((await composite(answering({ runner: "dak", reason: "速い" })).suggest(ctx, never)).llm).not.toBeNull();
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
    } finally {
      removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  test("an answer that is not a usable suggestion is dropped instead of reaching the task", async () => {
    for (const bad of [{ runner: "dak" }, { runner: "dak", reason: "   " }, { runner: "gpt-9", reason: "x" }, { runner: null, reason: "x" }, {}, null]) {
      expect((await composite(answering(bad)).suggest(ctx, never)).llm).toBeNull();
    }
    const long = await composite(answering({ runner: "dak", reason: "あ".repeat(5000) })).suggest(ctx, never);
    expect(long.llm!.reason).toHaveLength(MAX_LLM_REASON + 1); // truncated, with the ellipsis
  });

  test("a caller that gives up gets the rule table, and the primary is told", async () => {
    const ac = new AbortController();
    let told = false;
    const slow: Suggester = {
      async suggest(_c, signal) {
        signal.addEventListener("abort", () => (told = true));
        await new Promise((r) => setTimeout(r, 500));
        return { runner: "dak", reason: "遅い" } as RoutingSuggestion;
      },
    };
    const p = composite(slow, 10_000).suggest(ctx, ac.signal);
    await new Promise((r) => setTimeout(r, 10)); // let the primary actually start; aborting sooner never asks it at all
    ac.abort(new Error("the caller gave up"));
    expect((await p).llm).toBeNull();
    expect(told).toBe(true);
  });
});
