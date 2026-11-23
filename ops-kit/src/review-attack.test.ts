import { describe, expect, test } from "bun:test";
import { main } from "./cli.ts";
import { ATTACK_PROMPT, attackPrompt } from "./review-attack.ts";

describe("review-attack prompt", () => {
  test("prompt asks for the three sections and the Entry / Missing / Existing line, over the review's material", () => {
    const p = attackPrompt();
    expect(p).toBe(ATTACK_PROMPT);
    for (const part of ["### Findings", "### Entries read", "### Verdict", "Entry:", "Missing:", "Existing:", "- [blocker|should-fix|nit|question]", "- none"]) expect(p).toContain(part);
    for (const file of ["pr.md", "task.md", "pbi.md", "design-rules.md", "diff.patch"]) expect(p).toContain(`\`${file}\``);
    for (const check of ["authentication", "authorization", "destination", "format", "approval"]) expect(p).toContain(check);
  });

  test("prompt tells the reviewer not to write attack steps", () => {
    expect(attackPrompt()).toMatch(/Do NOT write attack steps: no list of attack scenarios, no payloads, no full commands/);
  });

  test("the command prints the prompt and refuses other arguments", async () => {
    const out: string[] = [];
    expect(await main(["review-attack", "prompt"], undefined, (s) => out.push(s), () => {})).toBe(0);
    expect(out.join("")).toContain("### Findings");
    expect(await main(["review-attack"], undefined, () => {}, () => {})).toBe(2);
    expect(await main(["review-attack", "prompt", "x"], undefined, () => {}, () => {})).toBe(2);
  });
});
