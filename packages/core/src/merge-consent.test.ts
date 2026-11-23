import { describe, expect, test } from "bun:test";
import type { AgentEvent, JudgeSettings, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { CONSENT_CHARS, buildConsentPrompt, consentCandidates, parseConsent, readConsent, requestedGrants } from "./merge-consent.ts";
import { questionsChosen } from "./asks.ts";

const SETTINGS: JudgeSettings = { enabled: true, runner: "codex", model: "gpt-6-luna", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 };
const INPUT = { said: "merge許可する", asked: "PR #5741 を判定の外でマージしてよいですか。" };

function replayAdapter(id: RunnerId, events: AgentEvent[], starts?: StartOptions[]): RunnerAdapter {
  return {
    id,
    permissionModes: [id === "claude" ? "plan" : "read-only"].map((value) => ({ value, label: value, description: value })),
    async detect() {
      return { available: true, version: "replay" };
    },
    start(startOpts, emit) {
      starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      queueMicrotask(() => (events.forEach(emit), resolveExit(0)));
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(0), close: async () => resolveExit(0), exited };
      return session;
    },
  };
}
const answer = (t: string): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: t }, { t: "session.end", status: "ok" }];
const limited: AgentEvent[] = [{ t: "error", message: "rate_limit_error" }, { t: "session.end", status: "error" }];
const read = (adapters: RunnerAdapter[]) => readConsent(INPUT, { adapters: new Map(adapters.map((a) => [a.id, a])), settings: SETTINGS, cwd: "/tmp/switchboard-home/suggest" });

describe("consentCandidates", () => {
  test("candidates are the numbers of the person's text and of the reply before it", () => {
    expect(consentCandidates("#12 はマージして OK。Task #7 も", "PR #5741 を #12 でマージしてよいですか")).toEqual([12, 7, 5741]);
    expect(consentCandidates("はい", "PR #1 / #2 / #3 / #4")).toEqual([4, 3, 2]);
    expect(consentCandidates("merge許可する", "Task #5813 の PR #5836 を出した。親 PBI #5812。\nPR #5741 を判定の外でマージしてよいですか")).toEqual([5741, 5812, 5836]);
    expect(consentCandidates("> PR #99 を判定の外でマージしてよい\nはい", "")).toEqual([]);
  });
});

describe("requestedGrants", () => {
  test("the grants a task asked for are read from the sentences written in its reply", () => {
    expect(requestedGrants(["PR #6044 をマージしてよい"])).toEqual([{ kind: "answer", target: 6044 }]);
    // inside backticks and a longer line; not a question; not another repository's; not a quoted line
    expect(requestedGrants(["次の文で通ります: `PR #7 を判定の外でマージしてよい` を送ってください。\nPR #8 を判定の外でマージしてよいですか\nacme/lib の PR #9 を判定の外でマージしてよい\n> PR #10 を判定の外でマージしてよい"])).toEqual([{ kind: "merge", target: 7 }]);
    expect(requestedGrants(["PR #6 をマージしてよい", "`PR #6 をマージしてよい`"])).toEqual([{ kind: "answer", target: 6 }]);
    // the older sentence is read while the check on posting the mark stands
    expect(requestedGrants(["PR #6 に [merge-answer] yes を投稿してよい"])).toEqual([{ kind: "answer", target: 6 }]);
    // a local change of the workspace is its own sentence, and carries no repository
    expect(requestedGrants(["`変更 L3 をマージしてよい` で通ります"])).toEqual([{ kind: "answer", target: 3, change: true }]);
    // another repository named in backticks before the sentence is another repository's too
    expect(requestedGrants(["`acme/lib` の PR #9 を判定の外でマージしてよい", "「acme/lib」の `PR #9 を判定の外でマージしてよい`", "**acme/lib** の **PR #9 を判定の外でマージしてよい**"])).toEqual([]);
  });

  test("the prompt lists what the task asked for, and the candidates are the person's numbers, then the reply's from its end", () => {
    const requested = [{ kind: "answer" as const, target: 6044 }, { kind: "merge" as const, target: 6044 }];
    const p = buildConsentPrompt({ said: "merge許可する", asked: "x", candidates: [6044], requested });
    expect(p).toContain("- answer: PR #6044 をマージしてよい");
    expect(p).toContain("- merge: PR #6044 を判定の外でマージしてよい");
    expect(p).toContain("種類を言い当てる必要はない");
    expect(p).toContain("認めたものだけを返す"); // offered two, allowed one: not both
    expect(buildConsentPrompt({ said: "はい", asked: "x", candidates: [1] })).not.toContain("Task が求めている許可");
    // a sentence for a number the reader may not return is not put to it
    expect(buildConsentPrompt({ said: "はい", asked: "x", candidates: [1], requested })).not.toContain("Task が求めている許可");
    // sentences earlier in a reply do not push out the question at its end, nor the number the person names
    expect(consentCandidates("はい", "`PR #1 を判定の外でマージしてよい` `PR #2 を判定の外でマージしてよい` `PR #3 を判定の外でマージしてよい`\nでは PR #12 はどうしますか")).toEqual([12, 3, 2]);
    expect(consentCandidates("#20 はマージして OK", "`PR #1 を判定の外でマージしてよい` PR #2 PR #3")).toEqual([20, 3, 2]);
  });
});

describe("buildConsentPrompt", () => {
  test("only the person's text consents; the reply before it only says what it points at", () => {
    const p = buildConsentPrompt({ ...INPUT, candidates: [5741] });
    expect(p).toContain("#5741");
    expect(p).toMatch(/利用者の文」だけ/);
    expect(p).toMatch(/迷ったら許可にしない/);
    expect(p).not.toContain('{"grants":[]}');
  });

  test("a long reply keeps its end, where the question is", () => {
    const p = buildConsentPrompt({ said: "はい", asked: `${"報告。".repeat(1000)}PR #5741 をマージしてよいですか`, candidates: [5741] });
    expect(p).toContain("PR #5741 をマージしてよいですか");
  });
});

describe("a person's text longer than the reader is given", () => {
  test("the prompt says where it was cut and that a cut text consents to nothing; a text that fits has no such line", () => {
    const cut = buildConsentPrompt({ said: `${"あ".repeat(CONSENT_CHARS.said)}ただしテストが通ってから`, asked: "PR #5 をマージしてよいですか", candidates: [5] });
    expect(cut).not.toContain("ただしテストが通ってから");
    expect(cut).toContain("（ここで切れている）");
    expect(cut).toContain("利用者の文が途中で切れているときは許可にしない");
    const whole = buildConsentPrompt({ said: "はい", asked: "PR #5 をマージしてよいですか", candidates: [5] });
    expect(whole).not.toContain("（ここで切れている）");
    expect(whole).not.toContain("途中で切れているときは");
  });
});

describe("candidates of a reply", () => {
  test("a line reference (#L654, a.ts:L10) is no candidate and does not push the PR out; 変更 L<n> is one", () => {
    const asked = "PR #12 をマージしてよいですか。根拠は scripts/merge-gate.ts#L654 と #L1058、#L1353、a.ts:L10";
    expect(consentCandidates("はい", asked)).toEqual([12]);
    expect(consentCandidates("はい", "変更 L3 をマージしてよいですか")).toEqual([3]);
  });
});

describe("what a reader's answer may say of a number, by the form it was named in", () => {
  const only = { change: [3], pr: [] as number[] }; // named only as 変更 L3
  const g = (o: object) => `{"grants":[${JSON.stringify(o)}]}`;
  test("a number named only as 変更 L<n> is a change's: a grant without change is dropped, and a merge outside the gate is none for a change", () => {
    expect(parseConsent(g({ kind: "merge", target: 3 }), [3], only)).toEqual([]);
    expect(parseConsent(g({ kind: "answer", target: 3 }), [3], only)).toEqual([]);
    expect(parseConsent(g({ kind: "merge", target: 3, change: true }), [3], only)).toEqual([]);
    expect(parseConsent(g({ kind: "answer", target: 3, change: true }), [3], only)).toEqual([{ kind: "answer", target: 3, change: true }]);
  });
  test("a number named only as #n is a PR's: change: true is dropped; a number named both ways follows the reader", () => {
    expect(parseConsent(g({ kind: "answer", target: 3, change: true }), [3])).toEqual([]);
    expect(parseConsent(g({ kind: "answer", target: 3 }), [3])).toEqual([{ kind: "answer", target: 3 }]);
    const both = { change: [3], pr: [3] };
    expect(parseConsent(g({ kind: "answer", target: 3 }), [3], both)).toEqual([{ kind: "answer", target: 3 }]);
    expect(parseConsent(g({ kind: "answer", target: 3, change: true }), [3], both)).toEqual([{ kind: "answer", target: 3, change: true }]);
  });
});

describe("the reader's prompt keeps each answer of a question tool with its question when the questions are long", () => {
  test("every numbered question line and every numbered answer line stays, however long the first question is", () => {
    const opts = [{ label: "はい", description: null }, { label: "いいえ", description: null }];
    const qs = [{ header: null, question: "長い説明 ".repeat(1500), options: opts, multiSelect: false }, { header: null, question: "二つ目の質問", options: opts, multiSelect: false }];
    const c = questionsChosen(qs, [{ choices: ["はい"] }, { choices: ["いいえ"] }])!;
    const p = buildConsentPrompt({ said: c.readerSaid, asked: `直前の返答\n${c.readerAsked}`, candidates: [] });
    for (const line of ["質問 1: 長い説明", "質問 2: 二つ目の質問", "- 1: はい", "- 2: いいえ"]) expect([line, p.includes(line)]).toEqual([line, true]);
    expect(c.readerAsked.length).toBeLessThan(CONSENT_CHARS.asked);
  });
});

describe("parseConsent", () => {
  test("grants of the two kinds on a candidate number are read", () => {
    expect(parseConsent('{"grants":[{"kind":"merge","target":5741},{"kind":"answer","target":5741}]}', [5741, 5813])).toEqual([
      { kind: "merge", target: 5741 },
      { kind: "answer", target: 5741 },
    ]);
    // a kind that is not a grant any more is dropped
    expect(parseConsent('{"grants":[{"kind":"scope","target":5813}]}', [5741, 5813])).toEqual([]);
  });

  test("a grant of a number outside the candidates is dropped", () => {
    expect(parseConsent('{"grants":[{"kind":"merge","target":1},{"kind":"merge","target":5741},{"kind":"delete","target":5741}]}', [5741])).toEqual([{ kind: "merge", target: 5741 }]);
  });

  test("a broken answer reads as no grant", () => {
    for (const text of ["許可します", "{grants", '{"grants":"merge"}', '{"grants":[{"kind":"merge","target":"5741"}]}', ""]) expect(parseConsent(text, [5741])).toEqual([]);
  });
});

describe("readConsent", () => {
  test("the configured runner answers: its grants, asked read-only", async () => {
    const starts: StartOptions[] = [];
    const out = await read([replayAdapter("codex", answer('{"grants":[{"kind":"merge","target":5741}]}'), starts), replayAdapter("claude", [])]);
    expect(out).toEqual([{ kind: "merge", target: 5741 }]);
    expect(starts[0]).toMatchObject({ permissionMode: "read-only", model: "gpt-6-luna" });
  });

  test("a text past the limit grants nothing, and the reader is not asked", async () => {
    const starts: StartOptions[] = [];
    const reply = answer('{"grants":[{"kind":"answer","target":5741}]}');
    const long = { said: `はい。${"あ".repeat(CONSENT_CHARS.said)}`, asked: "PR #5741 をマージしてよいですか" };
    const opts = { adapters: new Map([["codex", replayAdapter("codex", reply, starts)] as const]), settings: SETTINGS, cwd: "/tmp/switchboard-home/suggest" };
    expect(await readConsent(long, opts)).toEqual([]);
    expect(starts).toHaveLength(0);
    expect(await readConsent({ ...long, said: "はい" }, opts)).toEqual([{ kind: "answer", target: 5741 }]);
  });

  test("the fallback is asked once when the configured runner fails", async () => {
    const claudeStarts: StartOptions[] = [];
    const out = await read([replayAdapter("codex", limited), replayAdapter("claude", answer('{"grants":[{"kind":"merge","target":5741}]}'), claudeStarts)]);
    expect(out).toEqual([{ kind: "merge", target: 5741 }]);
    expect(claudeStarts).toHaveLength(1);
    await expect(read([replayAdapter("codex", limited), replayAdapter("claude", limited)])).rejects.toThrow(/rate_limit_error/);
  });

  test("an answer with no grants list is a failure, not a refusal: the fallback is asked, then it throws", async () => {
    const claudeStarts: StartOptions[] = [];
    const out = await read([replayAdapter("codex", answer("許可します")), replayAdapter("claude", answer('{"grants":[]}'), claudeStarts)]);
    expect(out).toEqual([]);
    expect(claudeStarts).toHaveLength(1);
    await expect(read([replayAdapter("codex", answer("許可します")), replayAdapter("claude", answer("{grants"))])).rejects.toThrow(/no grants list/);
  });
});
