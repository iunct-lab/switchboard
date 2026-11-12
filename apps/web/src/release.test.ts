// test-reads: apps/web/src/policies.ts apps/web/src/priceForm.ts apps/web/src/login.ts apps/web/src/i18n.ts apps/web/src/i18n/settings.ts
import { expect, test, describe } from "bun:test";
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
  expect(releasePanel({ managed: false })).toEqual({ lines: [{ text: "リリースから動いていないので昇格はありません", warn: false }], canPromote: false, promoteSha: null, busyTasks: 0, release: null });
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
  expect(at(1)!.promoteSha).toBe("b".repeat(40));
  expect(at(1, { behind: 0 })!.promoteSha).toBe("b".repeat(40));
  expect(at(0, { behind: 0 })!.lines[1]!.text).toContain("最新の版が動いています");
  expect(at(0)!.promoteSha).toBeNull();
});

test("panel: HEAD behind what runs is not 'latest' and promotes nothing", async () => {
  const { releasePanel } = await import("./release.ts");
  const v = releasePanel({ ...managed, ahead: 0, behind: 3 })!;
  expect(v.lines[1]!.text).toBe("HEAD: bbbbbbb feat: x — 動いている版のほうが新しい（チェックアウトはタグに追従しない）");
  expect(v.lines[1]!.text).not.toContain("最新の版が動いています");
  expect(v.canPromote).toBe(false);
  expect(v.promoteSha).toBeNull();
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

describe("release review", () => {
  test("promote without waiting is bound to what was pressed for: a poll that moves the target or its check drops it", async () => {
    const { pendingForce, promoteTarget, releasePanel } = await import("./release.ts");
    const status = (tag: string, review: Record<string, unknown>) => ({ ...managed, ahead: 0, latestRelease: { tag, sha: "a".repeat(40), ahead: 1 }, review: { tag, sha: "a".repeat(40), findings: [], reason: null, at: 0, ...review } }) as never;
    const target = (r: never) => promoteTarget(r, releasePanel(r));
    const failed = status("v1", { state: "failed", reason: "使用上限", taskId: "t1" });
    const pressed = target(failed);
    expect(pressed?.commit).toBe("v1");
    expect(pendingForce(pressed, target(failed))).toBe("v1");
    // a newer tag with a concern: only its own dialog can send it
    expect(pendingForce(pressed, target(status("v2", { state: "concern", findings: [{ path: "a.ts", why: "x" }], taskId: "t2" })))).toBeNull();
    // the same tag checked again (確かめ直す) and now with a concern: the approval was for the failed check, not these findings
    expect(pendingForce(pressed, target(status("v1", { state: "running", taskId: "t3" })))).toBeNull();
    expect(pendingForce(pressed, target(status("v1", { state: "concern", findings: [{ path: "a.ts", why: "x" }], taskId: "t3" })))).toBeNull();
    expect(pendingForce(null, target(failed))).toBeNull();
  });

  const latest = { tag: "v0.9.0", sha: "c".repeat(40), ahead: 41 };
  const review = (over: Record<string, unknown>) => ({ tag: "v0.9.0", sha: "c".repeat(40), state: "running", findings: [], reason: null, taskId: "task_1", at: Date.UTC(2030, 0, 1, 0, 5), ...over });
  const panel = async (extra: Record<string, unknown>) => (await import("./release.ts")).releasePanel({ ...managed, ahead: 0, latestRelease: latest, ...extra } as never)!;
  const texts = (p: { lines: Array<{ text: string }> }) => p.lines.map((l) => l.text);

  test("running: the release, the state and the waiting line; the update cannot be pressed", async () => {
    const hold = { tag: "v0.9.0", failed: false, reason: "v0.9.0 の差分を確認中", busyTasks: 0 };
    const p = await panel({ review: review({ state: "running" }), hold });
    expect(texts(p).some((x) => x.includes("昇格待ち"))).toBe(false); // the hold's Task-waiting wording would be wrong while the check runs
    expect(texts(p)).toContain("新しいリリース: v0.9.0（公開側）— 動いている版から 41 コミット先");
    expect(texts(p).some((x) => x.startsWith("HEAD:"))).toBe(false); // HEAD is what runs: "the latest version runs" would contradict the release
    expect(texts(p)).toContain("差分の確認: 確認中");
    expect(texts(p)).toContain("確認が終わるまで、この版には上がりません");
    expect(p.canPromote).toBe(false);
    expect(p.release).toEqual({ tag: "v0.9.0", state: "running", confirm: null, canReview: false, taskLink: "/task/task_1" });
  });

  test("ok: no concern with the time, the update is allowed without a dialog", async () => {
    const p = await panel({ review: review({ state: "ok" }), hold: { tag: "v0.9.0", failed: false, reason: "r", busyTasks: 2 } });
    expect(texts(p)).toContain("差分の確認: 懸念なし（1/1 09:05）");
    expect(texts(p)).toContain("v0.9.0 の昇格待ち: 動いている Task 2 件が終わると入る"); // once cleared, waiting for the Tasks is the hold
    expect(p.canPromote).toBe(true);
    expect(p.release).toMatchObject({ state: "ok", confirm: null, canReview: false });
  });

  test("concern: every finding is a line (not folded), the dialog lists them, and it can be checked again", async () => {
    const findings = [{ path: "packages/core/src/server.ts", why: "環境変数を外の URL へ送る" }, { path: "bun.lock", why: "レジストリ以外を指す依存" }];
    const p = await panel({ review: review({ state: "concern", findings }) });
    expect(texts(p)).toContain("差分の確認: 懸念あり 2 件（1/1 09:05）");
    expect(p.lines.filter((l) => l.text.startsWith("・")).map((l) => [l.text, l.warn])).toEqual([
      ["・packages/core/src/server.ts: 環境変数を外の URL へ送る", true],
      ["・bun.lock: レジストリ以外を指す依存", true],
    ]);
    expect(texts(p)).toContain("確認を通っていない版は自動では上がりません");
    expect(p.canPromote).toBe(true);
    expect(p.release!.confirm).toContain("v0.9.0 の差分の確認で懸念が見つかっています");
    expect(p.release!.confirm).toContain("・bun.lock: レジストリ以外を指す依存");
    expect(p.release).toMatchObject({ state: "concern", canReview: true });
  });

  test("failed: the reason is a warning, the dialog says it was not checked, and it can be checked again", async () => {
    const p = await panel({ review: review({ state: "failed", reason: "Claude Code が使用上限" }) });
    expect(p.lines.find((l) => l.text.startsWith("差分の確認"))).toEqual({ text: "差分の確認: 確かめられなかった — Claude Code が使用上限", warn: true });
    expect(p.release!.confirm).toBe("v0.9.0 の差分を確かめられていません（Claude Code が使用上限）。\n\n確かめずに、この版に更新しますか？");
    expect(p.release).toMatchObject({ state: "failed", canReview: true });
    expect((await panel({ review: review({ state: "failed" }) })).release!.confirm).toContain("理由が読めません");
  });

  test("no check yet, another tag's check, or a busy sb-rescue: the update waits", async () => {
    expect((await panel({ review: null })).canPromote).toBe(false);
    expect(texts(await panel({ review: null }))).toContain("差分の確認: まだ始まっていません");
    expect((await panel({ review: review({ tag: "v0.8.9", state: "ok" }) })).release!.state).toBeNull();
    expect((await panel({ review: review({ state: "ok" }), busy: "promote" })).canPromote).toBe(false);
  });

  test("HEAD behind what runs with a newer release: the HEAD line says what runs is newer, and the button names the tag, not HEAD", async () => {
    const p = await panel({ behind: 3, review: review({ state: "ok" }) });
    expect(texts(p).some((x) => x.includes("最新の版が動いています"))).toBe(false);
    expect(texts(p)).toContain("HEAD: bbbbbbb feat: x — 動いている版のほうが新しい（チェックアウトはタグに追従しない）");
    expect(texts(p)).toContain("新しいリリース: v0.9.0（公開側）— 動いている版から 41 コミット先");
    expect(p.canPromote).toBe(true);
    expect(p.promoteSha).toBeNull(); // what goes up is the tag (p.release), not the checkout's HEAD
    expect(p.release).toMatchObject({ tag: "v0.9.0", state: "ok" });
  });

  test("a release that is not newer than what runs (or cannot be counted) shows nothing", async () => {
    for (const ahead of [0, null]) {
      const p = await panel({ latestRelease: { ...latest, ahead }, review: review({ state: "ok" }) });
      expect(p.release).toBeNull();
      expect(texts(p).some((x) => x.includes("v0.9.0"))).toBe(false);
    }
  });

  test("a development origin (latestRelease null) reads as before", async () => {
    const { releasePanel } = await import("./release.ts");
    const p = releasePanel({ ...managed, latestRelease: null, review: null })!;
    expect(p.release).toBeNull();
    expect(p.lines.map((l) => l.text)).toEqual(["動いている版: aaaaaaa", "HEAD: bbbbbbb feat: x — 1 コミット先"]);
    expect(p.canPromote).toBe(true);
  });

  test("managed: false: the new release and how to run it under sb-rescue, no button", async () => {
    const { releasePanel } = await import("./release.ts");
    const p = releasePanel({ managed: false, latestRelease: latest })!;
    expect(p.release).toBeNull();
    expect(p.canPromote).toBe(false);
    expect(texts(p)).toEqual(["リリースから動いていないので昇格はありません", "新しいリリース: v0.9.0（公開側）。sb-rescue の下で動かすと、差分を確かめてこの画面から更新できます（docs/design/releases-and-rescue.md の「Start (Linux)」）"]);
    expect(releasePanel({ managed: false, latestRelease: null })!.lines).toHaveLength(1);
  });

  test("newVersionLink shows a public copy's newer tag, with or without sb-rescue", async () => {
    const { newVersionLink } = await import("./release.ts");
    expect(newVersionLink({ ...managed, ahead: 0, latestRelease: latest })).toBe("新しい版 v0.9.0 →");
    expect(newVersionLink({ managed: false, latestRelease: latest })).toBe("新しい版 v0.9.0 →");
    expect(newVersionLink({ ...managed, ahead: 0, latestRelease: { ...latest, ahead: 0 } })).toBeNull();
    expect(newVersionLink({ ...managed, ahead: 1, latestRelease: null })).toBe("新しい版 bbbbbbb →");
  });
});
