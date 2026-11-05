import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { NO_HOST } from "../ops-kit/src/secrets";
import type { Filed, OpenRequest } from "./file-request";
import { judgeStall, LAST_PASS_LINE, PUBLIC_LINE, publicTarget, readStallTags, skipReason, STALL_TITLE, stallFollow, stallRequest, type StallTag } from "./public-stall";
import type { FollowDeps } from "./tag-ci";

const H = 3600_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const shaOf = (tag: string) => tag.replace(/\D/g, "").padEnd(40, "a").slice(0, 40);

/** A fake clone: `tags` newest first, `hoursAgo` = when the tag was made, `body` = its Release (null = none). */
function clone(tags: Array<{ tag: string; hoursAgo: number; body: string | null }>, publicOut: string | Error = "v0.18.0 2026-11-01T00:00:00Z") {
  const viewed: string[] = [];
  const sh: FollowDeps["sh"] = async (cmd) => {
    if (cmd.includes("for-each-ref")) {
      return tags.map((t) => `${t.tag}\t${Math.floor((NOW - t.hoursAgo * H) / 1000)}\t${"f".repeat(40)}\t${shaOf(t.tag)}`).join("\n") + "\n";
    }
    if (cmd[0] === "gh" && cmd.includes("tagName,publishedAt")) {
      expect(cmd).toContain("pub/lic");
      if (publicOut instanceof Error) throw publicOut;
      return `${publicOut}\n`;
    }
    if (cmd[0] === "gh" && cmd[1] === "release" && cmd[2] === "view") {
      viewed.push(cmd[3]!);
      const body = tags.find((t) => t.tag === cmd[3])?.body;
      if (body === null || body === undefined) throw new Error("release not found");
      return body;
    }
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  return { sh, viewed };
}

/** The request side: filing (same title = open), comments, and the open request's text. */
function requests() {
  const open: OpenRequest[] = [];
  const comments: Array<{ ref: string; body: string }> = [];
  const bodies: string[] = [];
  const d = (sh: FollowDeps["sh"]): FollowDeps => ({
    sh,
    log: () => undefined,
    file: async (req): Promise<Filed> => {
      const same = open.find((o) => o.title === req.title);
      if (same) return { open: same.ref };
      open.push({ ref: `#${100 + open.length}`, title: req.title });
      bodies.push(req.body);
      return { filed: 99 + open.length };
    },
    comment: async (ref, body) => void comments.push({ ref, body }),
    open: async () => [...open, { ref: "#7", title: "要望: ほかの検査" }],
    text: async (ref) => [bodies[Number(ref.slice(1)) - 100] ?? "", ...comments.filter((c) => c.ref === ref).map((c) => c.body)].join("\n"),
    print: () => undefined,
  });
  return { d, open, comments, bodies };
}

const pass = (tag: string) => `- notes\n\n## CI\n[tag-ci] pass ${shaOf(tag)}\n`;
const fail = (tag: string) => `- notes\n\n## CI\n[tag-ci] fail ${shaOf(tag)}\n\n\`bun test\` が落ちた:\n    (fail) a > b\n`;
const t = (tag: string, hoursAgo: number, result: StallTag["result"]): StallTag => ({ tag, at: NOW - hoursAgo * H, result });

describe("judgeStall", () => {
  test("a tag newer than the newest pass for 25 hours is a stall, from that tag's time", () => {
    const j = judgeStall({ now: NOW, tags: [t("v3.0.0", 2, null), t("v2.0.0", 25, "fail"), t("v1.0.0", 30, "pass")], publicLatest: null });
    expect(j.stalled).toBe(true);
    if (j.stalled) {
      expect(j.since).toBe(NOW - 25 * H);
      expect(j.lastPass?.tag).toBe("v1.0.0");
      expect(j.newer.map((x) => x.tag)).toEqual(["v3.0.0", "v2.0.0"]);
    }
  });

  test("23 hours is not a stall; the newest tag passing is not one either", () => {
    expect(judgeStall({ now: NOW, tags: [t("v2.0.0", 23, "fail"), t("v1.0.0", 30, "pass")], publicLatest: null })).toEqual({ stalled: false, lastPass: "v1.0.0" });
    expect(judgeStall({ now: NOW, tags: [t("v2.0.0", 100, "pass"), t("v1.0.0", 200, "fail")], publicLatest: null })).toEqual({ stalled: false, lastPass: "v2.0.0" });
    expect(judgeStall({ now: NOW, tags: [], publicLatest: null })).toEqual({ stalled: false, lastPass: null });
  });

  test("no pass at all: every tag read waits, from the oldest", () => {
    const j = judgeStall({ now: NOW, tags: [t("v2.0.0", 1, null), t("v1.0.0", 48, "fail")], publicLatest: null });
    expect(j.stalled && j.since).toBe(NOW - 48 * H);
    expect(j.stalled && j.lastPass).toBeNull();
  });
});

describe("readStallTags", () => {
  test("reads back to the newest pass: the result of the peeled commit, a fail's step, a skip's reason, no Release", async () => {
    const c = clone([
      { tag: "v4.0.0", hoursAgo: 1, body: null },
      { tag: "v3.0.0", hoursAgo: 5, body: "- notes" },
      { tag: "v2.1.0", hoursAgo: 10, body: "- notes" },
      { tag: "v2.0.0", hoursAgo: 30, body: fail("v2.0.0") },
      { tag: "v1.0.0", hoursAgo: 40, body: pass("v1.0.0") },
      { tag: "v0.9.0", hoursAgo: 50, body: pass("v0.9.0") },
    ]);
    const tags = await readStallTags("/repo", "o/r", c.sh, { "v3.0.0": "録画が足りない: packages/a.jsonl" });
    expect(tags.map((x) => [x.tag, x.result, x.reason])).toEqual([
      ["v4.0.0", null, "Release が無いか読めない"],
      ["v3.0.0", null, "録画が足りない: packages/a.jsonl"],
      ["v2.1.0", null, "Release に [tag-ci] の印が無い"],
      ["v2.0.0", "fail", "`bun test` が落ちた"],
      ["v1.0.0", "pass", undefined],
    ]);
    expect(c.viewed).not.toContain("v0.9.0");
  });

  test("publicTarget reads ops.config.json's publicSync.target", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-public-stall-test-"));
    try {
      expect(publicTarget(dir)).toBeNull();
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ publicSync: { target: "pub/lic" } }));
      expect(publicTarget(dir)).toBe("pub/lic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stallFollow", () => {
  const stalled = [
    { tag: "v3.0.0", hoursAgo: 3, body: "- notes" },
    { tag: "v2.0.0", hoursAgo: 25, body: fail("v2.0.0") },
    { tag: "v1.0.0", hoursAgo: 40, body: pass("v1.0.0") },
  ];
  const opts = { target: "pub/lic", now: NOW, date: "2026-11-04", host: NO_HOST, skipped: { "v3.0.0": "録画が足りない: packages/a.jsonl packages/b.jsonl" } };

  test("a stall of 25 hours files one request with the reasons; the same day says nothing again", async () => {
    const q = requests();
    const c = clone(stalled);
    await stallFollow("o/r", "/repo", q.d(c.sh), opts);
    await stallFollow("o/r", "/repo", q.d(c.sh), opts);
    expect(q.open).toEqual([{ ref: "#100", title: STALL_TITLE }]);
    expect(q.comments).toEqual([]);
    const body = q.bodies[0]!;
    for (const s of [
      `${LAST_PASS_LINE}v1.0.0（2026-11-02T20:00Z）`,
      "  v3.0.0（2026-11-04T09:00Z）: 判定なし（録画が足りない: packages/a.jsonl packages/b.jsonl）",
      "  v2.0.0（2026-11-03T11:00Z）: fail（`bun test` が落ちた）",
      "公開側の最新のタグ: v0.18.0（2026-11-01T00:00:00Z）",
      "24 時間を超えて進んでいない（2026-11-03T11:00Z に付いたタグから）",
      "- 誰の言葉: 定期の検査",
      "- 経路: 公開の同期の見張り（scripts/public-stall.ts）",
      "## 派生 PBI",
    ]) expect(body).toContain(s);
  });

  test("23 hours files nothing", async () => {
    const q = requests();
    await stallFollow("o/r", "/repo", q.d(clone([{ tag: "v2.0.0", hoursAgo: 23, body: fail("v2.0.0") }, { tag: "v1.0.0", hoursAgo: 40, body: pass("v1.0.0") }]).sh), opts);
    expect(q.open).toEqual([]);
    expect(q.comments).toEqual([]);
  });

  test("an open request with the same title gets one comment a day instead of a second request", async () => {
    const q = requests();
    const c = clone(stalled);
    await stallFollow("o/r", "/repo", q.d(c.sh), opts);
    const next = { ...opts, now: NOW + 24 * H, date: "2026-11-05" };
    await stallFollow("o/r", "/repo", q.d(c.sh), next);
    await stallFollow("o/r", "/repo", q.d(c.sh), next);
    expect(q.open).toHaveLength(1);
    expect(q.comments).toHaveLength(1);
    expect(q.comments[0]!.ref).toBe("#100");
    expect(q.comments[0]!.body).toStartWith("2026-11-05 の見張り: まだ進んでいない");
    expect(q.comments[0]!.body).toContain("v2.0.0（2026-11-03T11:00Z）: fail");
  });

  const PUB2 = "v0.19.0 2026-11-05T01:00:00Z";
  test("a new public Release comments once on the open request and does not close it; a new pass alone says nothing", async () => {
    const q = requests();
    await stallFollow("o/r", "/repo", q.d(clone(stalled).sh), opts);
    const passed = [{ tag: "v3.0.0", hoursAgo: 3, body: pass("v3.0.0") }, ...stalled.slice(1)];
    // the newest pass moved, the public repository did not (the sync has not sent it yet): no move to tell
    await stallFollow("o/r", "/repo", q.d(clone(passed).sh), opts);
    expect(q.comments).toEqual([]);
    await stallFollow("o/r", "/repo", q.d(clone(passed, PUB2).sh), opts);
    await stallFollow("o/r", "/repo", q.d(clone(passed, PUB2).sh), { ...opts, date: "2026-11-05" });
    expect(q.comments).toEqual([{ ref: "#100", body: "公開が進んだ: v0.19.0（2026-11-05T01:00:00Z、タグの CI を通った最新のタグ v3.0.0）" }]);
    expect(q.open).toHaveLength(1);
    // no open request: nothing to say
    const r = requests();
    await stallFollow("o/r", "/repo", r.d(clone(passed, PUB2).sh), opts);
    expect(r.comments).toEqual([]);
  });

  test("a publication while a newer tag still stands: said once, next to the daily comment", async () => {
    const q = requests();
    await stallFollow("o/r", "/repo", q.d(clone(stalled).sh), opts);
    // v2.0.0 passes on a walk back and is published; v3.0.0 (newer, unjudged) has stood 27 hours a day later
    const moved = clone([{ tag: "v3.0.0", hoursAgo: 3, body: "- notes" }, { tag: "v2.0.0", hoursAgo: 25, body: pass("v2.0.0") }, stalled[2]!], PUB2);
    const next = { ...opts, now: NOW + 24 * H, date: "2026-11-05" };
    await stallFollow("o/r", "/repo", q.d(moved.sh), next);
    await stallFollow("o/r", "/repo", q.d(moved.sh), next);
    expect(q.comments.map((c) => c.body.split("\n")[0])).toEqual(["公開が進んだ: v0.19.0（2026-11-05T01:00:00Z、タグの CI を通った最新のタグ v2.0.0）", "2026-11-05 の見張り: まだ進んでいない"]);
  });

  test("the public repository unread when filed: the first read is written down once, and a publication after it is told", async () => {
    const q = requests();
    await stallFollow("o/r", "/repo", q.d(clone(stalled, new Error("403")).sh), opts);
    // the stall is over (v3.0.0 passed) before the public repository is read: the read is the baseline, not a move
    const passed = [{ tag: "v3.0.0", hoursAgo: 3, body: pass("v3.0.0") }, ...stalled.slice(1)];
    await stallFollow("o/r", "/repo", q.d(clone(passed).sh), opts);
    await stallFollow("o/r", "/repo", q.d(clone(passed).sh), opts);
    expect(q.comments.map((c) => c.body)).toEqual([`${PUBLIC_LINE}v0.18.0（2026-11-01T00:00:00Z。要望を立てたときは読めなかった。この後の公開をこれと比べる）`]);
    await stallFollow("o/r", "/repo", q.d(clone(passed, PUB2).sh), opts);
    expect(q.comments.at(-1)!.body).toStartWith("公開が進んだ: v0.19.0（");
    expect(q.comments).toHaveLength(2);
  });

  test("a body without the reasons (a value usable for auth) keeps the newest pass and the public tag: a stall that goes on says no false move", async () => {
    const q = requests();
    const secret = { ...opts, skipped: { "v3.0.0": "token ghp_" + "a".repeat(36) } };
    await stallFollow("o/r", "/repo", q.d(clone(stalled).sh), secret);
    expect(q.bodies[0]).not.toContain("ghp_");
    expect(q.bodies[0]).toContain(`${LAST_PASS_LINE}v1.0.0`);
    expect(q.bodies[0]).toContain(`${PUBLIC_LINE}v0.18.0`);
    await stallFollow("o/r", "/repo", q.d(clone(stalled).sh), { ...secret, now: NOW + 24 * H, date: "2026-11-05" });
    expect(q.comments.map((c) => c.body.split("\n")[0])).toEqual(["2026-11-05 の見張り: まだ進んでいない"]);
  });

  test("skipReason: missing recordings by name; a list that could not be read as its note", () => {
    expect(skipReason(["packages/a.jsonl", "packages/b.jsonl"])).toBe("録画が足りない: packages/a.jsonl packages/b.jsonl");
    expect(skipReason(["（録画の一覧を読めなかった）"])).toBe("（録画の一覧を読めなかった）");
  });

  test("a reason with a value usable for auth is not written", () => {
    const j = judgeStall({ now: NOW, tags: [{ ...t("v2.0.0", 30, null), reason: "token ghp_" + "a".repeat(36) }, t("v1.0.0", 40, "pass")], publicLatest: null });
    if (!j.stalled) throw new Error("expected a stall");
    const { body } = stallRequest({ ...j, publicLatest: null }, "2026-11-04", NO_HOST);
    expect(body).not.toContain("ghp_");
    expect(body).toContain("認証に使える値が含まれるので書かない");
  });
});
