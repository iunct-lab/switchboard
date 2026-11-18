// test-reads: container/release-boot-fake.ts packages/core/src/release-review.ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseReview } from "../packages/core/src/release-review.ts";
import { reviewReply, verdictOf } from "./release-boot-fake.ts";

// the E2E's fake runner must answer in the form the running version reads, or every check would read as "could not be checked"
test("the fake runner's reply is read as the verdict the E2E asked for", () => {
  expect(parseReleaseReview(reviewReply("ok"))).toEqual({ verdict: "ok", findings: [] });
  expect(parseReleaseReview(reviewReply("concern"))?.verdict).toBe("concern");
  expect(parseReleaseReview(reviewReply("concern"))?.findings.length).toBe(1);
});

test("the verdict is the home's e2e-verdict file, ok when there is none", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-e2e-verdict-"));
  try {
    expect(verdictOf(home)).toBe("ok");
    writeFileSync(join(home, "e2e-verdict"), "concern\n");
    expect(verdictOf(home)).toBe("concern");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
