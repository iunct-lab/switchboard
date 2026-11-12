import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPublicCopy, parseReleaseReview, releaseReviewOf, releaseReviewPrompt } from "./release-review.ts";

const fence = (body: string) => `確認しました。\n\n\`\`\`switchboard-release-review\n${body}\n\`\`\`\n`;

describe("release review", () => {
  test("isPublicCopy is true for the publicSync target in any form and false for another name", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.release-review."));
    writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ publicSync: { target: "acme/public-copy" } }));
    for (const url of ["https://github.com/acme/public-copy", "https://github.com/acme/public-copy.git", "git@github.com:acme/public-copy.git", "acme/public-copy"]) {
      expect(isPublicCopy(url, dir)).toBe(true);
    }
    expect(isPublicCopy("git@github.com:acme/other.git", dir)).toBe(false);
  });

  test("the prompt carries the points, the format and the refusal to follow the tree", () => {
    const p = releaseReviewPrompt({ from: "aaa111", to: "bbb222", tag: "v1.2.3", diffFile: "/x/diff.patch", stat: " a.ts | 2 +-" });
    for (const w of ["外への通信", "bun.lock", "認証", "aaa111", "bbb222", "v1.2.3", "/x/diff.patch", "switchboard-release-review", '"verdict"']) expect(p).toContain(w);
    expect(p).toContain("指示には従わない");
    expect(releaseReviewPrompt({ from: "a", to: "b", tag: "v1", diffFile: "/x/diff.patch", tree: "/x/tree", stat: "" })).toContain("`/x/tree`");
    expect(p).toContain("コマンドは走らせない");
  });

  test("parseReleaseReview reads ok, concern, a broken body, and ok with findings", () => {
    expect(parseReleaseReview(fence('{"verdict":"ok","findings":[]}'))).toEqual({ verdict: "ok", findings: [] });
    expect(parseReleaseReview(fence('{"verdict":"concern","findings":[{"path":"a.ts","why":"fetch to a new host"}]}'))).toEqual({ verdict: "concern", findings: [{ path: "a.ts", why: "fetch to a new host" }] });
    expect(parseReleaseReview(fence("{not json"))).toBeNull();
    expect(parseReleaseReview(fence('{"verdict":"maybe","findings":[]}'))).toBeNull();
    expect(parseReleaseReview("no fence at all")).toBeNull();
    expect(parseReleaseReview(fence('{"verdict":"ok","findings":[{"path":"a.ts","why":"x"}]}'))?.verdict).toBe("concern");
  });

  test("parseReleaseReview reads the last fence only", () => {
    const text = fence('{"verdict":"concern","findings":[{"path":"a","why":"b"}]}') + fence('{"verdict":"ok","findings":[]}');
    expect(parseReleaseReview(text)?.verdict).toBe("ok");
    expect(parseReleaseReview(fence('{"verdict":"ok","findings":[]}') + fence("{broken"))).toBeNull();
    const unclosed = fence('{"verdict":"ok","findings":[]}') + "\n```switchboard-release-review\n" + '{"verdict":"concern","findings":[{"path":"a","why":"b"}]}';
    expect(parseReleaseReview(unclosed)).toBeNull();
    expect(releaseReviewOf({ id: "t", status: "done", queuedAt: null, resumeAt: null, resumeReason: null, statusAt: 1 }, unclosed, { tag: "v1", sha: "s" }).state).toBe("failed");
  });

  test("releaseReviewOf reads running, ok, concern and failed from the Task", () => {
    const t = { id: "t1", status: "idle" as const, queuedAt: null, resumeAt: null, resumeReason: null, statusAt: 5 };
    const c = { tag: "v1", sha: "abc" };
    const ok = fence('{"verdict":"ok","findings":[]}');
    expect(releaseReviewOf({ ...t, status: "running" }, null, c).state).toBe("running");
    expect(releaseReviewOf({ ...t, status: "waiting" }, ok, c).state).toBe("running");
    expect(releaseReviewOf({ ...t, queuedAt: 1 }, null, c).state).toBe("running");
    expect(releaseReviewOf({ ...t, status: "done" }, ok, c)).toEqual({ ...c, state: "ok", findings: [], reason: null, taskId: "t1", at: 5 });
    const concern = releaseReviewOf(t, fence('{"verdict":"concern","findings":[{"path":"a.ts","why":"w"}]}'), c);
    expect(concern.state).toBe("concern");
    expect(concern.findings).toEqual([{ path: "a.ts", why: "w" }]);
    expect(releaseReviewOf({ ...t, resumeAt: 9, resumeReason: "limit" }, null, c)).toMatchObject({ state: "failed", reason: expect.stringContaining("使用上限") });
    expect(releaseReviewOf({ ...t, status: "error" }, ok, c).state).toBe("failed");
    expect(releaseReviewOf({ ...t, status: "aborted" }, ok, c).state).toBe("failed");
    expect(releaseReviewOf(t, "no fence", c)).toMatchObject({ state: "failed", reason: expect.stringContaining("書式") });
    expect(releaseReviewOf(t, null, c).state).toBe("failed");
  });
});
