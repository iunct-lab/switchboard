import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { arbiterPrompt, checkRulings, RULINGS_HEADING, VIEWPOINTS_HEADING } from "./review-arbiter.ts";

const ok = `${RULINGS_HEADING}\n- [implementer] \`a.ts:1\` — rule: README Design rules\n\n${VIEWPOINTS_HEADING}\n- error paths — covered\n`;

describe("review-arbiter prompt", () => {
  test("first round: material only, viewpoints, rule-based ruling, implementer when no rule, the two sections", () => {
    const p = arbiterPrompt(false);
    for (const f of ["handled.md", "viewpoints.md", "tests/", "pbi.md", "design-rules.md", "docs/design"]) expect(p).toContain(f);
    expect(p).toContain("do not read the whole diff");
    expect(p).toContain("rule for the implementer and write `none`");
    expect(p).toContain("covered");
    expect(p).toContain("- [implementer|reviewer] `path:line` — rule: ");
    expect(p).toContain(RULINGS_HEADING);
    expect(p).toContain(VIEWPOINTS_HEADING);
    expect(p).toContain("for display only");
  });

  test("follow-up: only the fixes and the findings ruled on; the first round's steps are not asked again", () => {
    const p = arbiterPrompt(true);
    expect(p).toContain("only the diff of those fixes");
    expect(p).toContain("do not open findings you did not rule on");
    expect(p).not.toContain("1. Viewpoints");
    expect(p).toContain(RULINGS_HEADING);
    expect(p).toContain("_review/fix.range-diff");
    expect(p).toContain("- [fixed|reviewer] `path:line`");
    expect(p).toContain("Copy the `### Viewpoints` section of your earlier output unchanged");
  });
});

describe("review-arbiter check", () => {
  test("a reviewer row whose rule is none reads as the implementer's side; one with a rule is the reviewer's", () => {
    expect(checkRulings(`${RULINGS_HEADING}\n- [reviewer] \`a.ts:1\` — rule: none\n\n${VIEWPOINTS_HEADING}\n- none\n`)).toEqual({ reviewerSide: [], missing: [], unreadable: [] });
    const row = "- [reviewer] `a.ts:1` — rule: README.md:40";
    expect(checkRulings(`${RULINGS_HEADING}\n${row}\n\n${VIEWPOINTS_HEADING}\n- none\n`).reviewerSide).toEqual([row]);
    for (const none of ["`none`", "None"]) expect(checkRulings(`${RULINGS_HEADING}\n- [reviewer] \`a.ts:1\` — rule: ${none}\n${VIEWPOINTS_HEADING}\n- none\n`).reviewerSide).toEqual([]);
  });

  test("follow-up: a reviewer-side ruling the fix closed is written fixed and no longer counts; one still open does", () => {
    const fixed = checkRulings(`${RULINGS_HEADING}\n- [fixed] \`a.ts:1\` — rule: README.md:40\n\n${VIEWPOINTS_HEADING}\n- error paths — covered\n`);
    expect(fixed).toEqual({ reviewerSide: [], missing: [], unreadable: [] });
    const open = "- [reviewer] `a.ts:1` — rule: README.md:40";
    expect(checkRulings(`${RULINGS_HEADING}\n${open}\n\n${VIEWPOINTS_HEADING}\n- error paths — covered\n`).reviewerSide).toEqual([open]);
  });

  test("a missing viewpoint is reported; a section missing or a row that does not parse is unreadable", () => {
    expect(checkRulings(`${RULINGS_HEADING}\n- none\n${VIEWPOINTS_HEADING}\n- a — covered\n- b — c — missing\n`).missing).toEqual(["- b — c — missing"]);
    expect(checkRulings("### Findings\n- none\n").unreadable).toHaveLength(2);
    expect(checkRulings(`${RULINGS_HEADING}\n- [maybe] \`a.ts:1\` — rule: x\n${VIEWPOINTS_HEADING}\n- none\n`).unreadable).toHaveLength(1);
    // a section shown only inside a fence is no section
    expect(checkRulings(`\`\`\`\n${RULINGS_HEADING}\n- none\n\`\`\`\n${VIEWPOINTS_HEADING}\n- none\n`).unreadable).toHaveLength(1);
  });

  test("the command: exit 0 / 1 (reviewer side, missing) / 2 (no section, no file, bad args)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.arbiter."));
    try {
      const run = async (text: string) => {
        const f = join(dir, "o.md");
        writeFileSync(f, text);
        const out: string[] = [];
        const code = await main(["review-arbiter", "check", f], undefined, (s) => out.push(s), () => {});
        return { code, out: out.join("") };
      };
      expect((await run(ok)).code).toBe(0);
      const rev = await run(ok.replace("[implementer]", "[reviewer]"));
      expect(rev.code).toBe(1);
      expect(rev.out).toContain("`a.ts:1`");
      expect((await run(ok.replace("covered", "missing"))).code).toBe(1);
      expect((await run("nothing\n")).code).toBe(2);
      expect(await main(["review-arbiter", "check", join(dir, "none.md")], undefined, () => {}, () => {})).toBe(2);
      expect(await main(["review-arbiter", "check"], undefined, () => {}, () => {})).toBe(2);
      const p: string[] = [];
      expect(await main(["review-arbiter", "prompt", "--follow-up"], undefined, (s) => p.push(s))).toBe(0);
      expect(p.join("")).toContain("only the diff of those fixes");
      expect(await main(["review-arbiter", "prompt", "x"], undefined, () => {}, () => {})).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
