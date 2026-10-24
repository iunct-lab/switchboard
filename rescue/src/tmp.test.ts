import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTmp, inUse, scanTmp } from "./tmp.ts";

let root: string;
let outside: string;
const OLD = (Date.now() - 3 * 60 * 60 * 1000) / 1000;

/** A directory with one file of `kb` KiB; both old unless `fresh`, and `freshChild` makes only the file new. */
function dir(name: string, kb: number, o: { fresh?: boolean; freshChild?: boolean } = {}) {
  const d = join(root, name);
  mkdirSync(join(d, "sub"), { recursive: true });
  writeFileSync(join(d, "sub", "f"), Buffer.alloc(kb * 1024, 1));
  if (!o.fresh) {
    if (!o.freshChild) utimesSync(join(d, "sub", "f"), OLD, OLD);
    utimesSync(join(d, "sub"), OLD, OLD);
    utimesSync(d, OLD, OLD);
  }
}

/** Where /tmp is Switchboard's alone (the cloud host), and where it is not. */
const OWNED = { owned: true };
const NOT_OWNED = { owned: false };
/** Removable where /tmp is Switchboard's; OWN_REMOVABLE anywhere. Both sorted. */
const REMOVABLE = [
  "bunx-1001-bun@1.4.2",
  "codex-home-AbCdEf",
  "node-compile-cache",
  "project-verify-ui-q9ZkLm",
  "sb-backlog-sync-e2e-l7EpOR",
  "sb-candidate-Qw3rTy",
  "switchboard.flow.Ab12Cd",
  "switchboard.review12.abcDEF",
  "switchboard.review1705b.Xy7aBc",
  "x.recheck3.a1b2c3",
];
const OWN_REMOVABLE = ["sb-candidate-Qw3rTy", "switchboard.review12.abcDEF", "x.recheck3.a1b2c3"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-tmp-test-"));
  outside = mkdtempSync(join(tmpdir(), "sb-tmp-outside-"));
  writeFileSync(join(outside, "keep"), "x");
  dir("switchboard.review12.abcDEF", 64);
  dir("x.recheck3.a1b2c3", 32);
  dir("sb-candidate-Qw3rTy", 16);
  dir("node-compile-cache", 128);
  dir("switchboard.review13.zzzzzz", 8, { fresh: true });
  dir("y.review14.qqqqqq", 8, { freshChild: true });
  dir("claude-1001", 256);
  dir("codex-home-AbCdEf", 8);
  dir("switchboard.flow.Ab12Cd", 8);
  dir("project-verify-ui-q9ZkLm", 8);
  dir("switchboard.review1705b.Xy7aBc", 8);
  dir("sb-backlog-sync-e2e-l7EpOR", 8);
  dir("bunx-1001-bun@1.4.2", 8);
  dir("pytest-of-dev", 8);
  dir("x.XXXXXX", 8);
  dir("node_modules", 8);
  dir("switchboard.tasks797.aaaaaa", 8);
  symlinkSync(outside, join(root, "z.review15.llllll"));
  writeFileSync(join(root, "w.review16.ffffff"), "a file");
  utimesSync(join(root, "w.review16.ffffff"), OLD, OLD);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("scanTmp lists the biggest first and marks only old directories of a known kind as removable", () => {
  const r = scanTmp(root, OWNED);
  expect(r.usage.total).toBeGreaterThan(0);
  expect(r.usage.percent).toBeGreaterThanOrEqual(0);
  expect(r.usage.percent).toBeLessThanOrEqual(100);
  const bytes = r.entries.map((e) => e.bytes);
  expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
  expect(r.entries[0]!.name).toBe("claude-1001");
  const keep = Object.fromEntries(r.entries.map((e) => [e.name, e.keep]));
  expect(keep).toEqual({
    "switchboard.review12.abcDEF": null,
    "x.recheck3.a1b2c3": null,
    "sb-candidate-Qw3rTy": null,
    "node-compile-cache": null,
    "switchboard.review13.zzzzzz": "recent",
    "y.review14.qqqqqq": "recent", // only a file inside is new
    "switchboard.flow.Ab12Cd": null,
    "project-verify-ui-q9ZkLm": null,
    "switchboard.review1705b.Xy7aBc": null,
    "sb-backlog-sync-e2e-l7EpOR": null,
    "bunx-1001-bun@1.4.2": null,
    "codex-home-AbCdEf": null,
    "claude-1001": "pattern",
    "pytest-of-dev": "pattern",
    "x.XXXXXX": "pattern", // the template itself
    "node_modules": "pattern",
    "switchboard.tasks797.aaaaaa": "pattern",
    "z.review15.llllll": "not-a-directory", // a symbolic link is not followed
    "w.review16.ffffff": "not-a-directory",
  });
  expect(r.cleanable.names.sort()).toEqual(REMOVABLE);
  const sum = r.entries.filter((e) => e.removable).reduce((n, e) => n + e.bytes, 0);
  expect(r.cleanable.bytes).toBe(sum);
  expect(r.cleanable.bytes).toBeGreaterThanOrEqual((64 + 32 + 16 + 128) * 1024);
  expect(r.owned).toBe(true);
});

test("where /tmp is not Switchboard's alone, only Switchboard's own kinds go: another app's mktemp directory or cache stays (#2058)", () => {
  const r = scanTmp(root, NOT_OWNED);
  expect(r.owned).toBe(false);
  expect(r.cleanable.names.sort()).toEqual(OWN_REMOVABLE);
  const keep = Object.fromEntries(r.entries.map((e) => [e.name, e.keep]));
  for (const name of REMOVABLE.filter((n) => !OWN_REMOVABLE.includes(n))) expect(keep[name]).toBe("pattern");
  const c = cleanTmp(root, REMOVABLE, NOT_OWNED);
  expect(c.removed.sort()).toEqual(OWN_REMOVABLE);
  expect(readdirSync(root)).toEqual(expect.arrayContaining(REMOVABLE.filter((n) => !OWN_REMOVABLE.includes(n))));
});

test("without the running processes (no /proc, or one that does not list this process) nothing goes: whether it is in use is unknown (#2058)", () => {
  const empty = mkdtempSync(join(tmpdir(), "sb-tmp-noproc-"));
  try {
    expect(inUse(root, join(empty, "missing"))).toBeNull();
    expect(inUse(root, empty)).toBeNull();
    const judge = { owned: true, proc: join(empty, "missing") };
    const r = scanTmp(root, judge);
    expect(r.cleanable.names).toEqual([]);
    for (const name of REMOVABLE) expect(r.entries.find((e) => e.name === name)!.keep).toBe("use-unknown");
    expect(r.entries.find((e) => e.name === "switchboard.review13.zzzzzz")!.keep).toBe("recent"); // the other reasons still say why first
    const c = cleanTmp(root, REMOVABLE, judge);
    expect(c.removed).toEqual([]);
    expect(c.skipped.map((s) => s.keep)).toEqual(REMOVABLE.map(() => "use-unknown"));
    expect(readdirSync(root)).toEqual(expect.arrayContaining(REMOVABLE));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("cleanTmp removes only the old directories of a known kind; everything else, a link's target and a path stay", () => {
  const names = readdirSync(root);
  const r = cleanTmp(root, [...names, "../x", "..", "", "nope.review1.aaaaaa"], OWNED);
  expect(r.removed.sort()).toEqual(REMOVABLE);
  expect(r.freedBytes).toBeGreaterThanOrEqual((64 + 32 + 16 + 128) * 1024);
  expect(readdirSync(root).sort()).toEqual(["claude-1001", "node_modules", "pytest-of-dev", "switchboard.review13.zzzzzz", "switchboard.tasks797.aaaaaa", "w.review16.ffffff", "x.XXXXXX", "y.review14.qqqqqq", "z.review15.llllll"]);
  expect(existsSync(join(outside, "keep"))).toBe(true);
  expect(r.skipped).toContainEqual({ name: "../x", keep: "name" });
  expect(r.skipped).toContainEqual({ name: "..", keep: "name" });
  expect(r.skipped).toContainEqual({ name: "nope.review1.aaaaaa", keep: "gone" });
  expect(r.skipped).toContainEqual({ name: "switchboard.review13.zzzzzz", keep: "recent" });
});

test("cleanTmp judges again right before removing: a directory written to since the scan stays", () => {
  const { cleanable } = scanTmp(root, OWNED);
  writeFileSync(join(root, "sb-candidate-Qw3rTy", "sub", "new"), "x");
  const r = cleanTmp(root, cleanable.names, OWNED);
  expect(r.removed).not.toContain("sb-candidate-Qw3rTy");
  expect(r.skipped).toContainEqual({ name: "sb-candidate-Qw3rTy", keep: "recent" });
});

test("cleanTmp goes on past a directory it cannot remove and says why it stayed", () => {
  chmodSync(join(root, "x.recheck3.a1b2c3", "sub"), 0o555); // its file cannot be unlinked
  try {
    const r = cleanTmp(root, ["x.recheck3.a1b2c3", "sb-candidate-Qw3rTy"], NOT_OWNED);
    expect(r.removed).toEqual(["sb-candidate-Qw3rTy"]);
    expect(r.skipped).toMatchObject([{ name: "x.recheck3.a1b2c3", keep: "failed" }]);
    expect(r.skipped[0]!.error).toContain("EACCES");
  } finally {
    chmodSync(join(root, "x.recheck3.a1b2c3", "sub"), 0o755);
  }
});

test("a directory a running process has as its cwd stays (in-use) until the process exits", async () => {
  dir("switchboard.busy.Ab12Cd", 8);
  const child = Bun.spawn(["sleep", "30"], { cwd: join(root, "switchboard.busy.Ab12Cd") });
  try {
    expect(inUse(root)!.has("switchboard.busy.Ab12Cd")).toBe(true);
    expect(scanTmp(root, OWNED).entries.find((e) => e.name === "switchboard.busy.Ab12Cd")!.keep).toBe("in-use");
    const r = cleanTmp(root, ["switchboard.busy.Ab12Cd"], OWNED);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([{ name: "switchboard.busy.Ab12Cd", keep: "in-use" }]);
  } finally {
    child.kill();
    await child.exited;
  }
  expect(cleanTmp(root, ["switchboard.busy.Ab12Cd"], OWNED).removed).toEqual(["switchboard.busy.Ab12Cd"]);
});

// prctl(PR_SET_DUMPABLE, 0) hides the process's cwd and files from its own user, as ssh-agent does; its command line stays.
// Not as root: root reads them anyway.
const python = process.platform === "linux" && process.getuid?.() !== 0 ? Bun.which("python3") : null;
test.skipIf(!python)("a process that cannot be read keeps what its command line names, also inside an option (#2058)", async () => {
  dir("switchboard.named.Ab12Cd", 8);
  dir("switchboard.option.Ab12Cd", 8);
  dir("switchboard.var.Ab12Cd", 8);
  dir("x.review1.abcdef", 8);
  dir("x.review2.abcdef", 8);
  dir("x.review3.abcdef", 8);
  const hide = "import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print('ready', flush=True); time.sleep(30)";
  const args = [join(root, "switchboard.named.Ab12Cd"), "--data=" + join(root, "switchboard.option.Ab12Cd", "sub"), "--log=/var" + join(root, "switchboard.var.Ab12Cd"), "-v", join(root, "x.review1.abcdef") + ":/work", "--dirs=" + join(root, "x.review2.abcdef") + "," + join(root, "x.review3.abcdef")];
  const child = Bun.spawn([python!, "-c", hide, ...args], { stdout: "pipe" });
  try {
    await child.stdout.getReader().read(); // "ready": its cwd and files are hidden now
    expect(() => readlinkSync(`/proc/${child.pid}/cwd`)).toThrow();
    const busy = inUse(root)!;
    expect(busy.has("switchboard.named.Ab12Cd")).toBe(true);
    expect(busy.has("switchboard.option.Ab12Cd")).toBe(true);
    expect(busy.has("switchboard.var.Ab12Cd")).toBe(false); // /var/<root>/… is another directory
    expect(busy.has("x.review1.abcdef")).toBe(true); // <root>/x.review1.abcdef:/work
    expect([busy.has("x.review2.abcdef"), busy.has("x.review3.abcdef")]).toEqual([true, true]); // a , list
    expect(cleanTmp(root, ["switchboard.named.Ab12Cd"], OWNED).skipped).toEqual([{ name: "switchboard.named.Ab12Cd", keep: "in-use" }]);
  } finally {
    child.kill();
    await child.exited;
  }
});
