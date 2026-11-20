// test-reads: ops-kit/src/fixtures/
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { areaOf, checkCompared, COMPARE_CLASSES, COMPARE_HEADING, comparePrompt, leftoverRequests, parseCompared } from "./review-compare.ts";
import { hasSection, speakerOf } from "./lint.ts";

// A comparison round's output, all fictional: 30 rows, 8 of them REGRESSION, spread over several areas
const fixture = await Bun.file(new URL("./fixtures/review-compare-round.md", import.meta.url)).text();

describe("review-compare prompt", () => {
  test("names the five classes with their definitions, the line's shape and the verdict line", () => {
    const p = comparePrompt();
    for (const c of COMPARE_CLASSES) expect(p.split("\n").filter((l) => l.startsWith(`- ${c}: `))).toHaveLength(1);
    // each class carries its own definition, so two swapped definitions are seen
    const defined = {
      REGRESSION: "main handles the input or state correctly, and HEAD does not",
      "NEW-FEATURE-GAP": "main has no such feature at all",
      "IMPROVED-BUT-INCOMPLETE": "main was missing more than HEAD is",
      SAME: "main has the same problem in the same way",
      "OWNER-DECIDED": "the owner's decision, or the PBI's acceptance criteria or decision log",
    };
    for (const c of COMPARE_CLASSES) expect(p.split("\n").find((l) => l.startsWith(`- ${c}: `))).toContain(defined[c]);
    expect(p).toContain("- <CLASS> `path:line` — ");
    expect(p).toContain("main: <");
    expect(p).toContain("HEAD: <");
    expect(p).toContain("Conditions: <");
    expect(p).toContain(COMPARE_HEADING);
    expect(p).toContain("### Verdict versus main");
    expect(p).toContain("at least as good as main");
    expect(p).toContain("`main.txt`");
  });

  test("what the prompt asks for is what check reads: its own example line parses, and its verdict is read", () => {
    const example = "- REGRESSION `a/b.ts:12` — x breaks. main: ok (`a/b.ts:3`). HEAD: no. Conditions: y.";
    const out = `${COMPARE_HEADING}\n${example}\n\n### Verdict versus main\nworse than main: one regression\n`;
    expect(parseCompared(out)).toMatchObject({ rows: [{ cls: "REGRESSION", path: "a/b.ts", line: 12 }], bad: [], verdict: "worse than main: one regression" });
  });
});

describe("review-compare check", () => {
  test("a 30-row round: exit 1 with the 8 regression lines, every row read", () => {
    const parsed = parseCompared(fixture);
    expect(parsed.bad).toEqual([]);
    expect(parsed.rows).toHaveLength(30);
    const r = checkCompared(fixture);
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(8);
    expect(r.lines.every((l) => l.startsWith("- REGRESSION `"))).toBe(true);
    expect(r.lines[0]).toContain("`packages/core/src/example-1.ts:10`");
  });

  test("the same text with every REGRESSION turned into SAME: exit 0", () => {
    expect(checkCompared(fixture.replaceAll("- REGRESSION `", "- SAME `"))).toEqual({ code: 0, lines: [] });
  });

  test("no section, or a line whose class cannot be read: exit 2", () => {
    expect(checkCompared("### Findings\n- none\n").code).toBe(2);
    const bogus = checkCompared(`${COMPARE_HEADING}\n- BOGUS \`a.ts:1\` — x\n`);
    expect(bogus.code).toBe(2);
    expect(bogus.lines[0]).toContain("BOGUS");
    // a regression next to an unreadable line is not hidden by it
    expect(checkCompared(`${COMPARE_HEADING}\n- REGRESSION \`a.ts:1\` — x\n- nonsense\n`).code).toBe(2);
    // a row not written as `- ` (numbered, starred, indented) is unreadable, not skipped: no regression is hidden by its shape
    for (const row of ["1. REGRESSION `a.ts:1` — x", "* REGRESSION `a.ts:1` — x", "  - REGRESSION `a.ts:1` — x"]) {
      expect(checkCompared(`${COMPARE_HEADING}\n${row}\n`).code).toBe(2);
    }
  });

  test("a heading the prompt does not ask for inside the section: exit 2, so the rows after it are not lost", () => {
    expect(checkCompared(`${COMPARE_HEADING}\n- SAME \`a.ts:1\` — x\n### Notes\n- REGRESSION \`b.ts:2\` — y\n`).code).toBe(2);
    expect(checkCompared(`${COMPARE_HEADING}\n- SAME \`a.ts:1\` — x\n\n### Regressions in detail\n- none\n`).code).toBe(0);
  });

  test("a path with a space is read; a section shown only inside a fence is no section", () => {
    expect(checkCompared(`${COMPARE_HEADING}\n- REGRESSION \`docs/Review Guide.md:12\` — x\n`)).toEqual({ code: 1, lines: ["- REGRESSION `docs/Review Guide.md:12` — x"] });
    expect(checkCompared(`An example:\n\n\`\`\`\n${COMPARE_HEADING}\n- none\n\`\`\`\n`).code).toBe(2);
    // a shorter fence line inside a longer fence does not close it
    expect(checkCompared(`\`\`\`\`markdown\n\`\`\`\n${COMPARE_HEADING}\n- none\n### Findings\n- none\n\`\`\`\n\`\`\`\`\n`).code).toBe(2);
    // after a closed fence, the real section is read
    expect(checkCompared(`\`\`\`\n${COMPARE_HEADING}\n\`\`\`\n${COMPARE_HEADING}\n- SAME \`a.ts:1\` — x\n`).code).toBe(0);
  });

  test("nothing still stands: `- none` in the section is exit 0", () => {
    expect(checkCompared(`${COMPARE_HEADING}\n- none\n\n### Verdict versus main\nat least as good as main: nothing stands\n`)).toEqual({ code: 0, lines: [] });
  });

  test("through the command: the file is read, regression lines go to stdout with exit 1, a missing file is exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-compare-"));
    try {
      const f = join(dir, "compared.md");
      writeFileSync(f, fixture);
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["review-compare", "check", f], undefined, (s) => out.push(s), (s) => err.push(s));
      expect({ code, out: out.length, err }).toEqual({ code: 1, out: 8, err: [] });
      expect(await main(["review-compare", "check", join(dir, "none.md")], undefined, () => {}, () => {})).toBe(2);
      expect(await main(["review-compare", "check"], undefined, () => {}, () => {})).toBe(2);
      const p: string[] = [];
      expect(await main(["review-compare", "prompt"], undefined, (s) => p.push(s))).toBe(0);
      expect(p.join("\n")).toBe(comparePrompt());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review-compare leftovers", () => {
  test("areaOf: two levels under packages and apps, the top directory for other paths, root for a top-level file", () => {
    expect(areaOf("packages/core/src/a.ts")).toBe("packages/core");
    expect(areaOf("packages/adapters/codex/src/index.ts")).toBe("packages/adapters");
    expect(areaOf("apps/web/src/release.ts")).toBe("apps/web");
    expect(areaOf("scripts/merge-gate.ts")).toBe("scripts");
    expect(areaOf("CLAUDE.md")).toBe("root");
  });

  test("the experiment's comment: the 22 rows that are not a regression are in one body each, once, and no regression is", () => {
    const { rows } = parseCompared(fixture);
    const reqs = leftoverRequests(rows, "PR 1", "2026-11-20");
    const rest = rows.filter((r) => r.cls !== "REGRESSION");
    expect(rest).toHaveLength(22);
    expect(reqs.map((r) => r.area)).toEqual([...reqs.map((r) => r.area)].sort());
    expect(reqs.map((r) => r.area)).toEqual(["apps/web", "docs", "ops-kit", "packages/adapters", "packages/core", "scripts"]);
    for (const r of rows) {
      const hits = reqs.filter((q) => q.body.includes(r.raw)).length;
      expect({ raw: r.raw, hits }).toEqual({ raw: r.raw, hits: r.cls === "REGRESSION" ? 0 : 1 });
    }
    expect(reqs.find((q) => q.area === "apps/web")!.body).toContain("`apps/web/src/example-17.ts:170`");
    for (const q of reqs) {
      expect(hasSection(q.body, "要望")).toBe(true);
      expect(hasSection(q.body, "出典")).toBe(true);
      expect(speakerOf(q.body)).toBe("エージェント");
      expect(q.body).toContain("- 経路: PR 1");
      expect(q.body).toContain("- いつ: 2026-11-20");
      expect(q.title).toBe(`要望: レビューで残った指摘（main と比べて後退でない）— ${q.area}`);
    }
  });

  test("a top-level file is the root group, and a row with backticks stays inside a longer fence", () => {
    const rows = parseCompared(`${COMPARE_HEADING}\n- SAME \`CLAUDE.md:3\` — x \`\`\`\`y\`\`\`\`. main: a. HEAD: b. Conditions: c.\n`).rows;
    const [r] = leftoverRequests(rows, "s", "2026-11-20");
    expect(r!.area).toBe("root");
    expect(r!.body).toContain("`````text\n- SAME");
  });

  test("through the command: bodies and titles.tsv are written, no row means nothing is written, an unreadable line is exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-leftovers-"));
    try {
      const f = join(dir, "compared.md");
      writeFileSync(f, fixture);
      const o = join(dir, "out");
      expect(await main(["review-compare", "leftovers", f, "--source", "PR 1", "--out", o], undefined, () => {}, () => {})).toBe(0);
      const titles = (await Bun.file(join(o, "titles.tsv")).text()).trimEnd().split("\n");
      expect(titles).toHaveLength(6);
      expect(titles[0]).toBe("1\t要望: レビューで残った指摘（main と比べて後退でない）— apps/web");
      expect(await Bun.file(join(o, "1.md")).text()).toContain("`apps/web/src/example-17.ts:170`");
      const none = join(dir, "none.md");
      writeFileSync(none, `${COMPARE_HEADING}\n- REGRESSION \`a.ts:1\` — x\n`);
      const o2 = join(dir, "out2");
      expect(await main(["review-compare", "leftovers", none, "--source", "s", "--out", o2], undefined, () => {}, () => {})).toBe(0);
      expect(await Bun.file(join(o2, "titles.tsv")).exists()).toBe(false);
      const bad = join(dir, "bad.md");
      writeFileSync(bad, `${COMPARE_HEADING}\n- BOGUS \`a.ts:1\` — x\n`);
      expect(await main(["review-compare", "leftovers", bad, "--source", "s", "--out", join(dir, "out3")], undefined, () => {}, () => {})).toBe(2);
      expect(await Bun.file(join(dir, "out3", "titles.tsv")).exists()).toBe(false);
      expect(await main(["review-compare", "leftovers", f, "--out", o], undefined, () => {}, () => {})).toBe(2);
      // a second run into the same directory would leave the first run's bodies next to its own
      expect(await main(["review-compare", "leftovers", f, "--source", "PR 1", "--out", o], undefined, () => {}, () => {})).toBe(2);
      expect(await main(["review-compare", "leftovers", f, "--source", "PR 1", "--out", f], undefined, () => {}, () => {})).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
