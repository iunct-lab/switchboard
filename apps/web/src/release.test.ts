// test-reads: apps/web/src/policies.ts apps/web/src/priceForm.ts apps/web/src/login.ts apps/web/src/i18n.ts apps/web/src/i18n/settings.ts
import { expect, test } from "bun:test";
import { describeRelease, rescueLink, shortSha } from "./release.ts";

const entry = { ts: 0, from: "a".repeat(40), to: "b".repeat(40), ok: false, reason: "the candidate exited (1) before it answered: Error: boom" } as const;

test("a rejected promotion says that the version did not change, and why", () => {
  expect(describeRelease({ ...entry, action: "rejected" })).toEqual({ text: "bbbbbbb の昇格を却下（今の版のまま） — the candidate exited (1) before it answered: Error: boom", ok: false });
});

test("an automatic rollback names both versions; a promotion is the only good news", () => {
  expect(describeRelease({ ...entry, action: "auto-rollback", from: entry.to, to: entry.from, reason: "went back by itself" }).text).toBe("bbbbbbb は切り替え後に確認できず、自動で aaaaaaa に戻した — went back by itself");
  expect(describeRelease({ ...entry, action: "promote", ok: true, reason: "confirmed" })).toEqual({ text: "bbbbbbb に昇格した — confirmed", ok: true });
  expect(shortSha(null)).toBe("なし");
});

test("promote sends the commit that was on the button, not whatever HEAD is by then", async () => {
  const { api } = await import("./api.ts");
  const real = globalThis.fetch;
  const sent: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ started: "promote", commit: "a".repeat(40) }, { status: 202 });
  }) as unknown as typeof fetch;
  try {
    await api.promote("a".repeat(40));
    expect(sent).toEqual([{ url: "/api/daemon/promote", body: { commit: "a".repeat(40), force: false } }]);
  } finally {
    globalThis.fetch = real;
  }
});

test("the rescue page's link (#399): only under sb-rescue and only when the daemon names the page, as it is", () => {
  expect(rescueLink(null)).toBeNull();
  expect(rescueLink({ managed: false, rescuePage: "http://127.0.0.1:47841" })).toBeNull();
  expect(rescueLink({ managed: true })).toBeNull();
  expect(rescueLink({ managed: true, rescuePage: "https://d1.example.net/rescue/" })).toBe("https://d1.example.net/rescue/");
  expect(rescueLink({ managed: true, rescuePage: "http://127.0.0.1:47841" })).toBe("http://127.0.0.1:47841");
});

test("promotion: the backlog line says which tag waits for how many Tasks, or which failed tag the app stays behind, with the rescue page", async () => {
  const { promotionLine } = await import("./release.ts");
  const managed = { managed: true, rescuePage: "https://d1.example.net/rescue/" };
  expect(promotionLine({ ...managed, hold: { tag: "v0.30.0", failed: false, reason: "1 件の Task が動いているので v0.30.0 の昇格を待つ", busyTasks: 2 } })).toEqual({ text: "v0.30.0 の昇格待ち: 動いている Task 2 件が終わると入る", link: null });
  expect(promotionLine({ ...managed, hold: { tag: "v0.30.0", failed: true, reason: "昇格に失敗した版のまま: v0.30.0", busyTasks: 0 } })).toEqual({ text: "昇格に失敗した版のまま: v0.30.0", link: "https://d1.example.net/rescue/" });
  expect(promotionLine({ ...managed, hold: null })).toBeNull();
  expect(promotionLine({ managed: false, hold: { tag: "v0.30.0", failed: false, reason: "", busyTasks: 1 } })).toBeNull();
  expect(promotionLine(null)).toBeNull();
});

const managed = { managed: true, head: "b".repeat(40), headSubject: "feat: x", current: "a".repeat(40), ahead: 1, busyTasks: 0, busy: null, history: [] } as const;

test("panel: outside sb-rescue there is one line and no button", async () => {
  const { releasePanel } = await import("./release.ts");
  expect(releasePanel(null)).toBeNull();
  expect(releasePanel({ managed: false })).toEqual({ lines: [{ text: "リリースから動いていないので昇格はありません", warn: false }], canPromote: false, busyTasks: 0 });
  expect(releasePanel({ managed: false, error: "sb-rescue did not answer" })!.lines).toEqual([{ text: "sb-rescue did not answer", warn: true }]);
});

test("panel: ahead says how far HEAD is, and only ahead >= 1 can promote", async () => {
  const { releasePanel } = await import("./release.ts");
  const at = (ahead: number | null | undefined, extra = {}) => releasePanel({ ...managed, ahead, ...extra });
  expect(at(1)!.lines.map((l) => l.text)).toEqual(["動いている版: aaaaaaa", "HEAD: bbbbbbb feat: x — 1 コミット先"]);
  expect(at(1)!.canPromote).toBe(true);
  expect(at(0)!.lines[1]!.text).toBe("HEAD: bbbbbbb feat: x — 最新の版が動いています");
  expect(at(0)!.canPromote).toBe(false);
  expect(at(null)!.lines[1]!.text).toContain("数えられません");
  expect(at(null)!.canPromote).toBe(false);
  expect(at(1, { busy: "promote" })!.canPromote).toBe(false); // sb-rescue is in the middle of something
});

test("panel: busy tasks, the hold, the last operation and a failure each get a line", async () => {
  const { releasePanel } = await import("./release.ts");
  expect(releasePanel({ ...managed, busyTasks: 0 })!.busyTasks).toBe(0);
  expect(releasePanel({ ...managed, busyTasks: 2 })!.busyTasks).toBe(2);
  const p = releasePanel({
    ...managed,
    dirty: true,
    hold: { tag: "v0.3.0", failed: false, reason: "r", busyTasks: 2 },
    history: [{ ts: 0, action: "rejected", from: "a", to: "b".repeat(40), ok: false, reason: "boom" }],
    lastError: "disk full",
  })!;
  expect(p.lines.map((l) => l.text)).toEqual([
    "動いている版: aaaaaaa",
    "HEAD: bbbbbbb feat: x — 1 コミット先",
    "未コミットの変更は含まれません",
    "直近: bbbbbbb の昇格を却下（今の版のまま） — boom",
    "v0.3.0 の昇格待ち: 動いている Task 2 件が終わると入る",
    "失敗: disk full",
  ]);
  expect(p.lines.filter((l) => l.warn).map((l) => l.text)).toEqual(["直近: bbbbbbb の昇格を却下（今の版のまま） — boom", "失敗: disk full"]);
});

test("panel: asked is a line until what runs is that sha, and an error is a warning (#2479)", async () => {
  const { releasePanel } = await import("./release.ts");
  const at = Date.UTC(2030, 0, 1, 0, 5); // 09:05 JST whatever the browser's time zone; another day than now, so with the date
  const asked = { tag: "v0.3.0", sha: "c".repeat(40), at, by: "backlog-next" as const };
  const texts = (r: Parameters<typeof releasePanel>[0]) => releasePanel(r)!.lines.filter((l) => l.text.includes("v0.3.0"));
  expect(texts({ ...managed, asked })).toEqual([{ text: "v0.3.0 の昇格を依頼（1/1 09:05、バックログを進める）", warn: false }]);
  expect(texts({ ...managed, asked: { ...asked, by: "check" } })[0]!.text).toBe("v0.3.0 の昇格を依頼（1/1 09:05、定期の確認）");
  expect(texts({ ...managed, asked: { ...asked, by: "idle" } })[0]!.text).toBe("v0.3.0 の昇格を依頼（1/1 09:05、Task が空いた）");
  expect(texts({ ...managed, asked: { ...asked, error: "refused" } })).toEqual([{ text: "v0.3.0 の昇格を依頼できない: refused", warn: true }]);
  // what runs caught up with it: no line; none asked: no line
  expect(texts({ ...managed, current: asked.sha, asked })).toEqual([]);
  expect(texts({ ...managed, asked: null })).toEqual([]);
});

test("newVersionLink shows only when HEAD is ahead of what runs under sb-rescue", async () => {
  const { newVersionLink } = await import("./release.ts");
  expect(newVersionLink(null)).toBeNull();
  expect(newVersionLink({ managed: false })).toBeNull();
  expect(newVersionLink({ ...managed, ahead: 0 })).toBeNull();
  expect(newVersionLink({ ...managed, ahead: null })).toBeNull();
  expect(newVersionLink({ ...managed, ahead: 1 })).toBe("新しい版 bbbbbbb →");
});

test("in English (#2448): the release lines, a policy row, a price form error and the login's end read in English", () => {
  // the language is read once when i18n.ts loads: a fresh process with the browser's choice set to en
  const at = (f: string) => JSON.stringify(new URL(f, import.meta.url).pathname);
  const code = `globalThis.localStorage = { getItem: (k) => (k === "switchboard.lang" ? "en" : null) };
const { describeRelease, releasePanel, shortSha } = await import(${at("./release.ts")});
const { policyRow, policyState } = await import(${at("./policies.ts")});
const { parsePriceForm, EMPTY_PRICE_FORM } = await import(${at("./priceForm.ts")});
const { sessionLabel } = await import(${at("./login.ts")});
const policy = { id: "p", op: "merge", target: "PR #1", when: [], scope: "pbi", pbi: 7, workspaceId: "w", expiresAt: null, revokedAt: null, uses: [] };
console.log(JSON.stringify([
  describeRelease({ ts: 0, action: "rejected", from: null, to: "b".repeat(40), ok: false, reason: "boom" }).text,
  shortSha(null),
  releasePanel({ managed: true, current: "a".repeat(40), head: "b".repeat(40), ahead: 2, dirty: true }).lines.map((l) => l.text),
  policyState(policy, 0).text,
  policyRow(policy, (id) => id, 0),
  parsePriceForm({ ...EMPTY_PRICE_FORM, model: "m", input: "x" }),
  sessionLabel({ idleUntil: 0, expiresAt: 0 }, 1).text.replace(/\\d+\\/\\d+ \\d+:\\d+/, "D"),
]));`;
  const r = Bun.spawnSync([process.execPath, "-e", code]);
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual([
    "Rejected promoting bbbbbbb (still on the current version) — boom",
    "none",
    ["Running version: aaaaaaa", "HEAD: bbbbbbb — commits ahead: 2", "Uncommitted changes are not included"],
    "Active",
    { scope: "Within this PBI (#7)", subject: "merge: PR #1", when: "No conditions", expires: "No expiry (once only)", uses: "Unused" },
    "input is not a number: x",
    "Logged in until D",
  ]);
});
