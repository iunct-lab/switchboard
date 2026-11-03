// test-reads: none
import { describe, expect, test } from "bun:test";
import { changedFiles, pickTests } from "./test-changed";

const tree: Record<string, string> = {
  "packages/protocol/src/index.ts": "",
  "packages/protocol/src/index.test.ts": `import "./index";`,
  "packages/core/src/a.ts": `import "@switchboard/protocol"; import "../../../scripts/gate";`,
  "packages/core/src/a.test.ts": `import "./a";`,
  "packages/core/package.json": `{"name":"@switchboard/core"}`,
  "packages/protocol/package.json": `{"name":"@switchboard/protocol","main":"src/index.ts"}`,
  "scripts/gate.ts": "",
  "scripts/gate.test.ts": `import "./gate";`,
  "apps/web/src/x.ts": "",
  "apps/web/src/x.test.ts": `import "./x";`,
  "docs/design/x.md": "",
};
const pick = (...changed: string[]) => pickTests(changed, Object.keys(tree), (p) => tree[p]!);

describe("test-changed", () => {
  test("pick tests by changed paths", () => {
    // the changed package's tests and those of what imports it
    expect(pick("scripts/gate.ts")).toEqual({ tests: ["packages/core/src/a.test.ts", "scripts/gate.test.ts"] });
    expect(pick("apps/web/src/x.ts")).toEqual({ tests: ["apps/web/src/x.test.ts"] });
    // a shared type widens, and so does what the selection cannot judge
    expect(pick("packages/protocol/src/index.ts")).toEqual({ full: "packages/protocol/src/index.ts: 共有の型" });
    expect(pick(".github/workflows/ci.yml")).toEqual({ full: ".github/workflows/ci.yml: CI の手順" });
    expect(pick("scripts/gone.ts")).toEqual({ full: "scripts/gone.ts: 今のツリーに無い（消したファイルの依存は辿れない）" });
    // nothing to run: a doc no test reads, and no change (the selection alone would run everything)
    expect(pick("docs/design/x.md")).toEqual({ tests: [] });
    expect(pick()).toEqual({ tests: [] });
  });

  test("changed files: since the fork, uncommitted and untracked, once each", () => {
    const seen: string[][] = [];
    const out: Record<string, string> = { "merge-base": "fork\n", diff: "b.ts\0a.ts\0", "ls-files": "c.ts\0a.ts\0" };
    expect(changedFiles((args) => (seen.push(args), out[args[0]!]!))).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(seen[0]).toEqual(["merge-base", "HEAD", "origin/main"]);
    expect(seen[1]).toEqual(["diff", "--name-only", "--no-renames", "-z", "fork"]);
    expect(seen[2]).toEqual(["ls-files", "--others", "--exclude-standard", "-z"]);
  });
});
