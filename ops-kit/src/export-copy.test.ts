import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { exportCopy, findPrivateWords, KIT, readPrivateWords } from "./export-copy.ts";
import { fakeGh } from "./gh.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "ops-kit-export-test."));
  made.push(d);
  return d;
}
function all(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? all(join(dir, n)).map((p) => `${n}/${p}`) : [n]));
}

function wordsFile(): string {
  const file = join(scratch(), "words.txt");
  writeFileSync(file, "# synthetic words\nquux-private-token\n");
  return file;
}
function fixtureKit(): string {
  const repo = scratch();
  const kit = join(repo, "kit");
  for (const d of ["src", "skills/a", "bin", "public", "fixtures", "template"]) mkdirSync(join(kit, d), { recursive: true });
  writeFileSync(join(repo, "LICENSE"), "license\n");
  writeFileSync(join(repo, "tsconfig.base.json"), '{"compilerOptions":{"strict":true}}');
  for (const f of ["README.md", "src/cli.ts", "bin/x", "public/SECURITY.md", "package.json", "fixtures/config-with-phase.json", "template/ops.config.json"]) writeFileSync(join(kit, f), "{}\n");
  writeFileSync(join(kit, "tsconfig.json"), '{"extends":"../tsconfig.base.json","compilerOptions":{}}');
  // Keep the fixture's Git metadata and index separate from the checkout.
  const git = (...args: string[]) => {
    const run = spawnSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return kit;
}

describe("export-copy", () => {
  test("requires an explicit words file without creating a copy", async () => {
    const dest = join(scratch(), "kit");
    expect(() => exportCopy({ dest })).toThrow("--words-file");
    const err: string[] = [];
    expect(await main(["export-copy", dest], fakeGh([]), () => {}, (s) => err.push(s))).toBe(1);
    expect(err.join("\n")).toContain("--words-file");
    expect(existsSync(dest)).toBe(false);
  });

  test("writes what runs, a KIT_VERSION, and no word of the list", () => {
    const dest = join(scratch(), "vendor", "ops-kit");
    const { version } = exportCopy({ dest, wordsFile: wordsFile(), now: new Date("2026-10-11T00:00:00Z") });
    const got = all(dest);
    expect(version).toMatch(/^commit [0-9a-f]{40}\ndate 2026-10-11T00:00:00.000Z\n/);
    expect(readFileSync(join(dest, "KIT_VERSION"), "utf8")).toBe(version);
    for (const f of ["LICENSE", "README.md", "package.json", "tsconfig.json", "src/cli.ts", "src/export-copy.ts", "bin/gh", "bin/ops-kit", "skills/issue-workflow/SKILL.md", "public/SECURITY.md", "public/.github/workflows/close-pull-requests.yml", "fixtures/config-with-phase.json", "template/ops.config.json"]) expect(got).toContain(f);
    expect(got.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
    expect(got.filter((f) => f.startsWith("fixtures/") && f !== "fixtures/config-with-phase.json")).toEqual([]);
    expect(statSync(join(dest, "bin/gh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dest, "LICENSE"), "utf8")).toContain("Apache License");
    // The kit's tsconfig extends a file outside the kit; the copy's stands alone
    const ts = JSON.parse(readFileSync(join(dest, "tsconfig.json"), "utf8"));
    expect(ts.extends).toBeUndefined();
    expect(ts.compilerOptions.strict).toBe(true);
    expect(findPrivateWords(dest, readPrivateWords(wordsFile()))).toEqual([]);
  });

  test("replaces an earlier copy, refuses a directory that is not one", () => {
    const dest = join(scratch(), "kit");
    exportCopy({ dest, wordsFile: wordsFile() });
    writeFileSync(join(dest, "stale.txt"), "left from an older copy");
    exportCopy({ dest, wordsFile: wordsFile() });
    expect(existsSync(join(dest, "stale.txt"))).toBe(false);

    const other = scratch();
    writeFileSync(join(other, "mine.txt"), "not a copy");
    expect(() => exportCopy({ dest: other, wordsFile: wordsFile() })).toThrow("前のコピー");
    expect(readFileSync(join(other, "mine.txt"), "utf8")).toBe("not a copy");
    expect(() => exportCopy({ dest: join(KIT, "src", "copy"), wordsFile: wordsFile() })).toThrow("キットの中");
  });

  test("a word of the list in the copy fails it and leaves nothing behind; an earlier copy stays", () => {
    const parent = scratch();
    const dest = join(parent, "kit");
    exportCopy({ dest, wordsFile: wordsFile() });
    const before = readFileSync(join(dest, "KIT_VERSION"), "utf8");
    const kit = fixtureKit();
    writeFileSync(join(kit, "README.md"), "quux-private-token\n");
    const list = wordsFile();
    expect(() => exportCopy({ dest, kit, wordsFile: list, now: new Date(0) })).toThrow(/README\.md:1: quux-private-token/);
    expect(readFileSync(join(dest, "KIT_VERSION"), "utf8")).toBe(before);
    expect(readdirSync(parent)).toEqual(["kit"]);

    const fresh = join(parent, "fresh");
    expect(() => exportCopy({ dest: fresh, kit, wordsFile: list })).toThrow("固有語");
    expect(existsSync(fresh)).toBe(false);
    expect(() => exportCopy({ dest: fresh, wordsFile: join(parent, "missing.txt") })).toThrow("リストがありません");
  });

  test("a link in the kit is copied as the file it points at, and that content is checked", () => {
    const kit = fixtureKit();
    const repo = join(kit, "..");
    writeFileSync(join(repo, "shared.md"), "outside the kit: quux-private-token\n");
    symlinkSync(join(repo, "shared.md"), join(kit, "skills/a/SKILL.md"));
    const list = join(repo, "words.txt");
    writeFileSync(list, "nothing-here\n");
    const dest = join(scratch(), "copy");
    exportCopy({ dest, kit, wordsFile: list });
    expect(lstatSync(join(dest, "skills/a/SKILL.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, "skills/a/SKILL.md"), "utf8")).toBe("outside the kit: quux-private-token\n");
    writeFileSync(list, "quux-private-token\n");
    expect(() => exportCopy({ dest: join(scratch(), "copy"), kit, wordsFile: list })).toThrow("skills/a/SKILL.md:1: quux-private-token");
  });

  test("a file name counts as well as a line", () => {
    const dir = scratch();
    mkdirSync(join(dir, "quux-private-token"));
    writeFileSync(join(dir, "quux-private-token", "a.txt"), "ok\nQuux-private-token inside\n");
    expect(findPrivateWords(dir, ["quux-private-token"])).toEqual(["quux-private-token/a.txt: quux-private-token（名前）", "quux-private-token/a.txt:2: quux-private-token"]);
  });

  test("cli: export-copy <dest> prints the version; a missing dest is a usage error", async () => {
    const dest = join(scratch(), "kit");
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(["export-copy", dest, "--words-file", wordsFile()], fakeGh([]), (s) => out.push(s), (s) => err.push(s))).toBe(0);
    expect(out.join("\n")).toContain("commit ");
    expect(existsSync(join(dest, "KIT_VERSION"))).toBe(true);
    expect(await main(["export-copy"], fakeGh([]), (s) => out.push(s), (s) => err.push(s))).toBe(1);
    expect(err.join("\n")).toContain("export-copy <dest>");
  });
});
