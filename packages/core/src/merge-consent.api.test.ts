// test-reads: none
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StartOptions, Task } from "@switchboard/protocol";
import { GRANT_WAIT_MS, mergeGranted } from "../../../ops-kit/src/backlog-client.ts";
import { loadConfig } from "./config.ts";
import { noteMergeGrant } from "./server/task-hooks.ts";
import { CONSENT_WAIT_CAP_MS } from "./server/merge-consent.ts";
import { IDLE_TIMEOUT_SECONDS } from "./server.ts";
import { mergeGrantsRoutes } from "./routes/merge-grants.ts";
import { NO_GH, NO_HISTORY, fakeAdapter, j, startServer, waitFor } from "./api-test-harness.ts";

// A person's own words are read for a merge grant by the judge's runner: here a second fake runner ("codex") that answers
// with the grants it is told to, so the daemon's real `readConsent` runs. The Task's own runner is the fake "claude".
describe("a reply in the person's own words as a merge grant", () => {
  const HEAD = "a".repeat(40);
  const MOVED = "b".repeat(40);
  const QUESTION = "PR #12 をマージしてよいですか？（判定は止まっています）";
  // as the screen sends it: this origin and Sec-Fetch-Site; a bare call has neither
  const post = (b: string, path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: b, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
  const bare = (b: string, path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const grantedAt = (b: string, taskId: string, kind: string, target: number, head: string | null = HEAD) =>
    fetch(`${b}/api/merge-grants?taskId=${taskId}&repo=o%2Fa&kind=${kind}&target=${target}${head ? `&head=${head}` : ""}`).then(j) as Promise<{ granted: boolean }>;
  const statuses = async (b: string, taskId: string): Promise<string[]> => ((await fetch(`${b}/api/tasks/${taskId}`).then(j)).events as Array<{ ev: AgentEvent }>).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));

  /** A daemon with one finished Task in a clone whose origin is o/a, whose last reply is `QUESTION`, and a reader that answers `answer` once `gate` opens. */
  const boot = async (answer: string | null, gate?: Promise<unknown>, question = QUESTION) => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-merge-consent-"));
    const clone = join(h, "clone");
    mkdirSync(clone);
    Bun.spawnSync(["git", "init", "-q"], { cwd: clone });
    Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/o/a.git"], { cwd: clone });
    const sent: string[] = [];
    const readerStarts: StartOptions[] = [];
    const heads = { now: HEAD, asked: 0 };
    const task = fakeAdapter([{ t: "session.start", runner: "claude", runnerSessionId: "s1", cwd: "/tmp" }, { t: "session.end", status: "ok", turn: "t1", summary: question }], { sends: sent, lingers: true });
    // the reader answers with an assistant text; no answer at all is a turn that says nothing
    const reader = fakeAdapter(answer === null ? [{ t: "session.end", status: "ok" }] : [{ t: "message.delta", role: "assistant", text: answer }, { t: "session.end", status: "ok" }], { id: "codex", starts: readerStarts, gate });
    const gh: typeof NO_GH = async (...a: unknown[]) => {
      if (!(a[0] as string[]).includes("headRefOid")) return NO_GH();
      heads.asked++;
      return { code: 0, stdout: JSON.stringify({ headRefOid: heads.now }), stderr: "" };
    };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [task, reader], { port: 0, selfdevChecks: false, gh });
    const b = `http://127.0.0.1:${c.server.port}`;
    expect((await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ judge: { runner: "codex" } }) })).status).toBe(200);
    const t = (await post(b, "/api/tasks", { cwd: clone, title: "t", prompt: "p" }).then(j)) as Task;
    await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
    const stop = async () => {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    };
    return { b, c, t, sent, readerStarts, heads, stop };
  };
  const reads = (...g: Array<{ kind: string; target: number }>) => JSON.stringify({ grants: g });

  test("the person's own words after a question about PR #n record a merge grant of its head", async () => {
    const x = await boot(reads({ kind: "merge", target: 12 }));
    try {
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false });
      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" })).status).toBe(200);
      // the check in front of `gh` asks right after the reply and gets the read's answer
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: true });
      expect(x.readerStarts).toHaveLength(1);
      expect(x.readerStarts[0]!.prompt).toContain("merge許可する"); // what was said
      expect(x.readerStarts[0]!.prompt).toContain(QUESTION); // and what it points at
      // the head of the PR now, and no other; another PR is not granted
      expect(await grantedAt(x.b, x.t.id, "merge", 12, MOVED)).toEqual({ granted: false });
      expect(await grantedAt(x.b, x.t.id, "merge", 13)).toEqual({ granted: false });
    } finally {
      await x.stop();
    }
  });

  test("answer grants are read the same way", async () => {
    const x = await boot(reads({ kind: "answer", target: 12 }));
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "#12 は [merge-answer] yes で進めて" });
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: true });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false }); // only what the reader gave
    } finally {
      await x.stop();
    }
  });

  test("a text a task sent or a bare API call is not read", async () => {
    const x = await boot(reads({ kind: "merge", target: 12 }));
    try {
      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する", from: "task_sender" })).status).toBe(200);
      expect((await bare(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" })).status).toBe(200);
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false });
      expect(x.readerStarts).toHaveLength(0);
      // the same text from the screen is read: the reader is in place, so the two above were left unread
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: true });
      expect(x.readerStarts).toHaveLength(1);
    } finally {
      await x.stop();
    }
  });

  test("a fixed sentence is recorded without the reader", async () => {
    const x = await boot(reads());
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "PR #12 を判定の外でマージしてよい" });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: true });
      expect(x.readerStarts).toHaveLength(0);
      expect(await statuses(x.b, x.t.id)).toEqual([]); // nothing was read, so nothing is said of a reading
    } finally {
      await x.stop();
    }
  });

  test("the reply reaches the task before the reader answers, and the check waits for the reader", async () => {
    let open!: () => void;
    const x = await boot(reads({ kind: "merge", target: 12 }), new Promise<void>((r) => (open = r)));
    try {
      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" })).status).toBe(200);
      expect(x.sent).toContain("merge許可する"); // sent while the reader has not answered
      let answered = false;
      const check = grantedAt(x.b, x.t.id, "merge", 12).then((r) => ((answered = true), r));
      await Bun.sleep(150);
      expect(answered).toBe(false); // the check waits
      open();
      expect(await check).toEqual({ granted: true });
    } finally {
      open();
      await x.stop();
    }
  });

  test("the kit's check waits for the reader", async () => {
    let open!: () => void;
    const x = await boot(reads({ kind: "merge", target: 12 }), new Promise<void>((r) => (open = r)));
    try {
      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" })).status).toBe(200);
      // the reader is still running: the kit's own check (`gh`), against this daemon, with the kit's real timeout
      const timer = setTimeout(() => open(), 6_000);
      const t0 = Date.now();
      const env = { BACKLOG_URL: `${x.b}/api/backlog`, OPS_KIT_TASK_ID: x.t.id };
      const merge = await mergeGranted(env, "o/a", "merge", 12, fetch, HEAD);
      expect(merge).toBe(true);
      expect(Date.now() - t0).toBeGreaterThan(5_500); // it outlasted the 5 s of the kit's other calls
      clearTimeout(timer);
    } finally {
      open();
      await x.stop();
    }
  }, 30_000);

  test("the kit waits longer than the daemon holds a read, and the daemon answers before it drops the connection", () => {
    // else the kit would give up first, or the server would cut the response, and the check would read "cannot be reached" while the read is still going
    expect(GRANT_WAIT_MS).toBeGreaterThan(CONSENT_WAIT_CAP_MS);
    expect(CONSENT_WAIT_CAP_MS).toBeLessThan(IDLE_TIMEOUT_SECONDS * 1000);
  });

  test("a commit pushed after the reply is not granted", async () => {
    let open!: () => void;
    const x = await boot(reads({ kind: "merge", target: 12 }), new Promise<void>((r) => (open = r)));
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" });
      await waitFor(async () => x.heads.asked > 0); // the head as of the reply is read
      x.heads.now = MOVED; // pushed while the reader is still answering
      open();
      expect(await grantedAt(x.b, x.t.id, "merge", 12, HEAD)).toEqual({ granted: true });
      expect(await grantedAt(x.b, x.t.id, "merge", 12, MOVED)).toEqual({ granted: false });
    } finally {
      open();
      await x.stop();
    }
  });

  test("a check waits for a read queued behind the one it found", async () => {
    const pendingConsent = new Map<string, Promise<void>>();
    let granted = false;
    let second!: () => void;
    const first = Promise.resolve().then(() => Bun.sleep(30)).then(() => {
      // a second reply came in while the first was read: its read is queued behind it and grants
      const next: Promise<void> = new Promise<void>((r) => (second = r)).then(() => void (granted = true)).finally(() => pendingConsent.delete("t1"));
      pendingConsent.set("t1", next);
      setTimeout(() => second(), 30);
    });
    pendingConsent.set("t1", first);
    const sc = { pendingConsent, settings: () => ({ judgeAndChoice: { judgeTimeoutMs: 5_000 } }), db: { hasMergeGrant: () => granted }, json: (b: unknown) => Response.json(b), bad: (m: string) => new Response(m, { status: 400 }) } as unknown as Parameters<typeof mergeGrantsRoutes>[0];
    const get = (mergeGrantsRoutes(sc)["/api/merge-grants"] as { GET: (r: Request) => Promise<Response> }).GET;
    const r = await get(new Request(`http://x/api/merge-grants?taskId=t1&repo=o%2Fa&kind=merge&target=12&head=${HEAD}`));
    expect(await r.json()).toEqual({ granted: true });
  });

  test("a grant sentence the task wrote in its stop is not read when the person presses it", async () => {
    const x = await boot(reads({ kind: "merge", target: 12 }));
    try {
      x.c.db.appendEvent(x.t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: null, issue: null, taskId: x.t.id }, op: "gh pr merge", target: "PR #12", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: "PR #12 はテスト待ちだがマージしてよい", at: Date.now() - 30_000 } });
      x.c.db.updateTask(x.t.id, { outcome: "needs_action" });
      const ask = ((await fetch(`${x.b}/api/asks`).then(j)).asks as Array<{ id: string; kind: string; taskId?: string }>).find((a) => a.kind === "stop")!;
      expect(ask).toBeDefined();
      expect((await post(x.b, "/api/asks/answer", { id: ask.id, answer: { kind: "grant" } })).status).toBe(200);
      expect(x.sent).toContain("PR #12 はテスト待ちだがマージしてよい"); // the Task gets it, as before
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false }); // the Task's own words grant nothing
      expect(x.readerStarts).toHaveLength(0);
    } finally {
      await x.stop();
    }
  });

  // a reply that stops for the answer mark, as a task writes it: the question, the sentence, and the stop's fence with its grant
  const ASKS_ANSWER = 'PR #12 をマージしてよいですか。OK なら次の許可文を選んでください: `PR #12 に [merge-answer] yes を投稿してよい`\n\n```switchboard-stop\n{"id":"m","op":"PR #12 のマージ","target":"PR #12","reason":"decision","grant":"PR #12 に [merge-answer] yes を投稿してよい"}\n```';

  test("the person's 'merge OK' after a stop that asked for the answer mark records the answer grant, though the reader read a merge", async () => {
    const x = await boot(reads({ kind: "merge", target: 12 }), undefined, ASKS_ANSWER);
    try {
      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する。すすめて" })).status).toBe(200);
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: true });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: true });
      expect(x.readerStarts[0]!.prompt).toContain("- answer: PR #12 に [merge-answer] yes を投稿してよい"); // the reader is told what was asked
      expect(await grantedAt(x.b, x.t.id, "answer", 12, MOVED)).toEqual({ granted: false });
    } finally {
      await x.stop();
    }
  });

  test("a consent to the answer mark is not made a merge outside the gate because the task also asked for that", async () => {
    // the reply offers both steps for PR 12; the person allows only the mark, and the reader reads that
    const both = "止まりました。`PR #12 に [merge-answer] yes を投稿してよい` か、`PR #12 を判定の外でマージしてよい` で通ります";
    const x = await boot(reads({ kind: "answer", target: 12 }), undefined, both);
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "yes の印だけどうぞ" });
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: true });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false });
      // both were put to the reader, with the word that a part allowed is only that part
      expect(x.readerStarts[0]!.prompt).toContain("- merge: PR #12 を判定の外でマージしてよい");
      expect(x.readerStarts[0]!.prompt).toContain("認めたものだけを返す");
    } finally {
      await x.stop();
    }
    // a kind of grant the reader may no longer give is dropped: it grants nothing, whatever number it shares
    const y = await boot(reads({ kind: "scope", target: 12 }), undefined, both);
    try {
      await post(y.b, `/api/tasks/${y.t.id}/send`, { text: "Task #12 のパスは足していいよ" });
      await waitFor(async () => y.readerStarts.length > 0);
      expect(await grantedAt(y.b, y.t.id, "merge", 12)).toEqual({ granted: false });
      expect(await grantedAt(y.b, y.t.id, "answer", 12)).toEqual({ granted: false });
    } finally {
      await y.stop();
    }
  });

  test("a consent whose head could not be read does not take the place of an earlier grant that has one", async () => {
    const x = await boot(reads({ kind: "merge", target: 12 }));
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "PR #12 に [merge-answer] yes を投稿してよい" });
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: true });
      x.heads.now = "not-a-sha"; // GitHub answers nothing usable now
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false }); // waits for the read; no head, no grant
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: true }); // the earlier one still stands
      expect((await statuses(x.b, x.t.id)).some((l) => l.includes("head を読めず、まだ通りません"))).toBe(true);
    } finally {
      await x.stop();
    }
  });

  test("a stop record is not what the task asked for: only the reply the person answers is read for it", async () => {
    // long ago the task stopped for a merge of PR 5 outside the gate and the person did not give it; the reply now asks about PR 12
    const x = await boot(reads({ kind: "answer", target: 12 }, { kind: "answer", target: 5 }));
    try {
      x.c.db.appendEvent(x.t.id, { t: "stop.record", stop: { id: "old", work: { workspaceId: null, issue: null, taskId: x.t.id }, op: "gh pr merge", target: "PR #5", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: "PR #5 を判定の外でマージしてよい", at: Date.now() } });
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "はい。#5 も yes の印でどうぞ" });
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: true });
      // the reader read an answer consent of 5: the stop's merge is not added to it
      expect(await grantedAt(x.b, x.t.id, "answer", 5)).toEqual({ granted: true });
      expect(await grantedAt(x.b, x.t.id, "merge", 5)).toEqual({ granted: false });
      expect(x.readerStarts[0]!.prompt).not.toContain("merge: PR #5");
    } finally {
      await x.stop();
    }
  });

  test("what the task asked for is not granted when the reader reads no consent", async () => {
    const x = await boot(reads(), undefined, ASKS_ANSWER);
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "ちょっと待って" });
      expect(x.readerStarts[0]!.prompt).toContain("- answer: PR #12 に [merge-answer] yes を投稿してよい"); // it was asked, and put to the reader
      expect(await grantedAt(x.b, x.t.id, "answer", 12)).toEqual({ granted: false });
      expect(await grantedAt(x.b, x.t.id, "merge", 12)).toEqual({ granted: false });
    } finally {
      await x.stop();
    }
  });

  test("a screen answer that gives its grants once is not read", async () => {
    // a stage start passes its Issue's answer with the answer's id (`source`): a read could end after a second start, or find nothing and never spend it
    const pendingConsent = new Map<string, Promise<void>>();
    const judgeStop = new AbortController();
    judgeStop.abort(); // the read is not what this looks at: it ends at once
    const task = { id: "t1", cwd: "/x", workspaceId: null } as unknown as Task;
    const sc = { db: { getTask: () => task, lastReplyText: () => QUESTION, getWorkspaceBacklogSource: () => null }, originRepoOf: () => "o/a", grantHeadOf: async () => HEAD, pendingConsent, judgeStop } as unknown as Parameters<typeof noteMergeGrant>[0];
    await noteMergeGrant(sc, "t1", "#12 はマージして OK", { via: "screen", source: "op1" });
    expect(pendingConsent.size).toBe(0);
    await noteMergeGrant(sc, "t1", "#12 はマージして OK", { via: "screen", taskWrote: true });
    expect(pendingConsent.size).toBe(0);
    // the same words without either are read
    void noteMergeGrant(sc, "t1", "#12 はマージして OK", { via: "screen" });
    expect(pendingConsent.size).toBe(1);
  });

  test("the conversation gets one line for what was recorded, and one when nothing could be read", async () => {
    const x = await boot(reads({ kind: "merge", target: 12 }));
    try {
      await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "merge許可する" });
      await grantedAt(x.b, x.t.id, "merge", 12); // waits for the reader
      const lines = (await statuses(x.b, x.t.id)).filter((s) => s.includes("許可"));
      expect(lines).toEqual([`返信を許可として記録しました: PR #12 を判定の外でマージ（head ${HEAD.slice(0, 7)}）、PR #12 に [merge-answer] yes を投稿（head ${HEAD.slice(0, 7)}）`]); // a merge covers the answer mark
    } finally {
      await x.stop();
    }
    // a reader that answers nothing (and a fallback that does not either): nothing is recorded, and the line says so
    const y = await boot(null);
    try {
      await post(y.b, `/api/tasks/${y.t.id}/send`, { text: "merge許可する" });
      expect(await grantedAt(y.b, y.t.id, "merge", 12)).toEqual({ granted: false });
      const lines = (await statuses(y.b, y.t.id)).filter((s) => s.includes("許可"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("返信から許可を読めませんでした（");
      expect(lines[0]).toEndWith("）。決まった文でも送れます");
    } finally {
      await y.stop();
    }
    // a reader that read it and found no consent: nothing recorded and nothing said
    const z = await boot(reads());
    try {
      await post(z.b, `/api/tasks/${z.t.id}/send`, { text: "テストが通ったらね" });
      expect(await grantedAt(z.b, z.t.id, "merge", 12)).toEqual({ granted: false });
      expect((await statuses(z.b, z.t.id)).filter((s) => s.includes("許可"))).toEqual([]);
    } finally {
      await z.stop();
    }
  });
});
