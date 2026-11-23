// test-reads: bun.lock
import { describe, expect, test } from "bun:test";
import { lockChanges, main, RECHECK_COMMANDS, type Deps } from "./recheck.ts";

/** A fake `Deps`: `codes` answers the commands that fail (by their text), `git` answers the reads (by their text). */
function fake(codes: Record<string, number> = {}, git: Record<string, string | null> = {}) {
  const ran: string[] = [];
  const out: string[] = [];
  const deps: Deps = {
    run: (argv) => (ran.push(argv.join(" ")), codes[argv.join(" ")] ?? 0),
    read: (argv) => git[argv.join(" ")] ?? null,
    out: (s) => out.push(s),
  };
  return { deps, ran, out };
}
const lock = (pkgs: Record<string, unknown[]>) => JSON.stringify({ lockfileVersion: 2, packages: pkgs });
const DIFF = "git diff --name-only origin/main...HEAD";
const BASE = "git merge-base origin/main HEAD";

describe("scripts/recheck.ts", () => {
  test("runs the commands of the kind in order and stops at the first failure", () => {
    const rescue = RECHECK_COMMANDS.rescue.map((c) => c.join(" "));
    const ok = fake();
    expect(main(["rescue"], ok.deps)).toBe(0);
    expect(ok.ran).toEqual(rescue);
    const bad = fake({ [rescue[0]!]: 3 });
    expect(main(["rescue"], bad.deps)).toBe(3);
    expect(bad.ran).toEqual([rescue[0]!]); // the E2E after it did not run
    const mig = fake();
    expect(main(["migration"], mig.deps)).toBe(0);
    expect(mig.ran).toEqual(RECHECK_COMMANDS.migration.map((c) => c.join(" ")));
    const size = fake();
    expect(main(["size"], size.deps)).toBe(1); // a kind that needs a reader is not a command's
    expect(size.ran).toEqual([]);
  });

  test("security:lockfile refuses a lock file that is not bun.lock before it installs, and lists the changed entries otherwise", () => {
    const other = fake({}, { [DIFF]: "bun.lock\nservices/x/package-lock.json\n" });
    expect(main(["security:lockfile"], other.deps)).toBe(1);
    expect(other.ran).toEqual([]);
    expect(other.out.join("\n")).toContain("services/x/package-lock.json");
    const unread = fake();
    expect(main(["security:lockfile"], unread.deps)).toBe(1);

    const before = lock({ a: ["a@1.0.0", "", {}, "sha512-A"], b: ["b@1.0.0", "", {}, "sha512-B"] });
    const after = lock({ a: ["a@1.1.0", "", {}, "sha512-A2"], c: ["c@2.0.0", "", {}, "sha512-C"] });
    const ok = fake({}, { [DIFF]: "bun.lock\nsrc/a.ts\n", [BASE]: "mb1\n", "git show mb1:bun.lock": before, "git show HEAD:bun.lock": after });
    expect(main(["security:lockfile"], ok.deps)).toBe(0);
    expect(ok.ran).toEqual(RECHECK_COMMANDS["security:lockfile"].map((c) => c.join(" ")));
    expect(ok.out.filter((l) => l.startsWith("bun.lock:"))).toEqual([
      "bun.lock: a: a@1.0.0 source=- integrity=sha512-A -> a@1.1.0 source=- integrity=sha512-A2",
      "bun.lock: b: b@1.0.0 source=- integrity=sha512-B -> (none)",
      "bun.lock: c: (none) -> c@2.0.0 source=- integrity=sha512-C",
    ]);
    // a failed install or license check ends it before the list
    // main gained b and bumped c after the fork: the merge base's lock is the "before", so only this PR's change is listed
    const moved = fake({}, { [DIFF]: "bun.lock\n", [BASE]: "fork\n", "git show fork:bun.lock": lock({ a: ["a@1.0.0", "", {}, "sha512-A"] }), "git show origin/main:bun.lock": lock({ a: ["a@1.0.0", "", {}, "sha512-A"], b: ["b@1.0.0", "", {}, "sha512-B"] }), "git show HEAD:bun.lock": lock({ a: ["a@1.0.1", "", {}, "sha512-A1"] }) });
    expect(main(["security:lockfile"], moved.deps)).toBe(0);
    expect(moved.out.filter((l) => l.startsWith("bun.lock:"))).toEqual(["bun.lock: a: a@1.0.0 source=- integrity=sha512-A -> a@1.0.1 source=- integrity=sha512-A1"]);
    const failed = fake({ "bun run licenses:check": 1 }, { [DIFF]: "bun.lock\n" });
    expect(main(["security:lockfile"], failed.deps)).toBe(1);
    expect(failed.out.some((l) => l.startsWith("変わった"))).toBe(false);
  });

  test("with --head it runs only while the checkout is still on that head and clean", () => {
    const on = fake({}, { "git rev-parse HEAD": "abc\n", "git status --porcelain": "" });
    expect(main(["migration", "--head", "abc"], on.deps)).toBe(0);
    expect(on.ran).toHaveLength(1);
    const moved = fake({}, { "git rev-parse HEAD": "def\n", "git status --porcelain": "" });
    expect(main(["migration", "--head", "abc"], moved.deps)).toBe(1);
    expect(moved.ran).toEqual([]);
    const dirty = fake({}, { "git rev-parse HEAD": "abc\n", "git status --porcelain": " M a.ts\n" });
    expect(main(["migration", "--head", "abc"], dirty.deps)).toBe(1);
    expect(dirty.ran).toEqual([]);
  });

  test("a git, tarball or workspace entry that changes is listed as it is written", () => {
    const git = (rev: string) => lock({ g: ["g@git+https://example.test/g.git#" + rev, { dependencies: {} }, "g-" + rev] });
    const lines = lockChanges(git("1"), git("2"), "bun.lock");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("git+https://example.test/g.git#2");
    // only the dependencies of a registry entry changed: both sides are written out, so the line shows what differs
    const [x, y] = [lock({ a: ["a@1", "", { dependencies: { z: "1" } }, "sha512-A"] }), lock({ a: ["a@1", "", { dependencies: { z: "2" } }, "sha512-A"] })];
    expect(lockChanges(x, y, "bun.lock")[0]).toContain('"z":"2"');
  });

  test("a source or an integrity change alone is listed, an unchanged entry and the trailing commas of bun.lock are not", () => {
    const text = lock({ a: ["a@1.0.0", "https://r.example", {}, "sha512-A"] });
    expect(lockChanges(text, text, "bun.lock")).toEqual([]);
    expect(lockChanges(text, lock({ a: ["a@1.0.0", "https://other.example", {}, "sha512-A"] }), "bun.lock")).toHaveLength(1);
    const real = Bun.file(new URL("../bun.lock", import.meta.url).pathname);
    return real.text().then((t) => expect(lockChanges(t, t, "bun.lock")).toEqual([]));
  });
});
