// test-reads: none
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTmp, inUse, scanTmp, sweepTmp } from "./tmp.ts";

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
  "foo-abcdef",
  "node-compile-cache",
  "project-verify-ui-q9ZkLm",
  "sb-backlog-sync-e2e-l7EpOR",
  "sb-candidate-Qw3rTy",
  "switchboard.flow.Ab12Cd",
  "switchboard.review12.abcDEF",
  "switchboard.review1705b.Xy7aBc",
  "switchboard.review3212r.qnploh",
  "switchboard.tasks797.aaaaaa",
  "tmpab12cd_x",
  "x.recheck3.a1b2c3",
];
const OWN_REMOVABLE = ["sb-candidate-Qw3rTy", "switchboard.review12.abcDEF", "switchboard.review1705b.Xy7aBc", "switchboard.review3212r.qnploh", "x.recheck3.a1b2c3"];

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
  dir("switchboard.review3212r.qnploh", 8);
  dir("foo-abcdef", 8);
  dir("tmpab12cd_x", 8);
  dir("codex-daemon-1001", 8);
  dir("aws_crt_cross_process_lock", 8);
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
    "switchboard.tasks797.aaaaaa": null, // a suffix of six small letters
    "switchboard.review3212r.qnploh": null,
    "foo-abcdef": null,
    "tmpab12cd_x": null, // Python's mkdtemp
    "codex-daemon-1001": "pattern",
    "aws_crt_cross_process_lock": "pattern",
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
  expect(readdirSync(root).sort()).toEqual(["aws_crt_cross_process_lock", "claude-1001", "codex-daemon-1001", "node_modules", "pytest-of-dev", "switchboard.review13.zzzzzz", "w.review16.ffffff", "x.XXXXXX", "y.review14.qqqqqq", "z.review15.llllll"]);
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
  chmodSync(root, 0o555); // nothing right under it can be unlinked, and only the entry's own folders are made writable
  try {
    const r = cleanTmp(root, ["x.recheck3.a1b2c3", "sb-candidate-Qw3rTy"], NOT_OWNED);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toMatchObject([
      { name: "x.recheck3.a1b2c3", keep: "failed" },
      { name: "sb-candidate-Qw3rTy", keep: "failed" },
    ]);
    expect(r.skipped[0]!.error).toContain("EACCES");
  } finally {
    chmodSync(root, 0o755);
  }
});

test("a folder without permissions inside does not keep an old directory: sweepTmp removes it all, and a link inside is not followed", () => {
  const entry = join(root, "x.recheck3.a1b2c3");
  mkdirSync(join(entry, "locked", "deeper"), { recursive: true });
  writeFileSync(join(entry, "locked", "deeper", "f"), "x");
  symlinkSync(outside, join(entry, "locked", "link"));
  chmodSync(outside, 0o500);
  utimesSync(join(entry, "locked", "deeper", "f"), OLD, OLD);
  utimesSync(join(entry, "locked", "deeper"), OLD, OLD);
  lutimesSync(join(entry, "locked", "link"), OLD, OLD);
  chmodSync(join(entry, "locked", "deeper"), 0o000);
  chmodSync(join(entry, "locked"), 0o000);
  utimesSync(join(entry, "locked"), OLD, OLD);
  utimesSync(entry, OLD, OLD);
  try {
    const s = sweepTmp(root, OWNED);
    expect(s.skipped).toBe(0);
    expect(s.removed).toBe(REMOVABLE.length);
    expect(existsSync(entry)).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o500); // the link's target keeps its mode
  } finally {
    chmodSync(outside, 0o755);
  }
});

test("a new file in a folder that could not be read keeps the directory: it is judged again once the folder can be read", () => {
  const entry = join(root, "x.recheck3.a1b2c3");
  mkdirSync(join(entry, "locked"));
  writeFileSync(join(entry, "locked", "new"), "x");
  chmodSync(join(entry, "locked"), 0o000);
  utimesSync(join(entry, "locked"), OLD, OLD);
  utimesSync(entry, OLD, OLD);
  expect(scanTmp(root, OWNED).cleanable.names).toContain("x.recheck3.a1b2c3");
  const r = cleanTmp(root, ["x.recheck3.a1b2c3"], OWNED);
  expect(r.removed).toEqual([]);
  expect(r.skipped).toEqual([{ name: "x.recheck3.a1b2c3", keep: "recent" }]);
  expect(existsSync(join(entry, "locked", "new"))).toBe(true);
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

// The owner's press on the rescue page, judged apart from the sweep: the age they picked, any name, files too.
const MANUAL_2H = { kind: "manual", staleMs: 2 * 60 * 60 * 1000 } as const;
const FORCE = { kind: "force" } as const;
/** Stands for someone else's /tmp: every entry here is another uid's. */
const SOMEONE_ELSE = { owned: false, uid: (process.getuid?.() ?? 0) + 4242 };

test("the manual clean takes any name and files of this user's left alone the picked age; new, in-use and someone else's stay", async () => {
  dir("notes", 8); // no known kind
  lutimesSync(join(root, "z.review15.llllll"), OLD, OLD);
  const child = Bun.spawn(["sleep", "30"], { cwd: join(root, "notes") });
  try {
    const r = scanTmp(root, NOT_OWNED, Date.now(), MANUAL_2H);
    const keep = Object.fromEntries(r.entries.map((e) => [e.name, e.keep]));
    expect(keep["claude-1001"]).toBeNull(); // not a known kind
    expect(keep["w.review16.ffffff"]).toBeNull(); // a file
    expect(keep["z.review15.llllll"]).toBeNull(); // the link itself
    expect(keep["switchboard.review13.zzzzzz"]).toBe("recent");
    expect(keep["notes"]).toBe("in-use");
    expect(r.forcible.count).toBe(r.entries.length);
    const c = cleanTmp(root, [...readdirSync(root), "../x"], NOT_OWNED, Date.now(), MANUAL_2H);
    expect(readdirSync(root).sort()).toEqual(["notes", "switchboard.review13.zzzzzz", "y.review14.qqqqqq"]);
    expect(existsSync(join(outside, "keep"))).toBe(true); // the link went, not what it points to
    expect(c.skipped).toContainEqual({ name: "../x", keep: "name" });
    expect(c.skipped).toContainEqual({ name: "notes", keep: "in-use" });
    // a shorter age takes what 2 hours left
    expect(cleanTmp(root, ["y.review14.qqqqqq"], NOT_OWNED, Date.now() + 2 * 60 * 60 * 1000, { kind: "manual", staleMs: 30 * 60 * 1000 }).removed).toEqual(["y.review14.qqqqqq"]);
  } finally {
    child.kill();
    await child.exited;
  }
  const other = cleanTmp(root, readdirSync(root), SOMEONE_ELSE, Date.now(), FORCE);
  expect(other.removed).toEqual([]);
  expect(new Set(other.skipped.map((s) => s.keep))).toEqual(new Set(["owner"]));
});

test("the force clean takes everything of this user's, a minute old and in use too; someone else's, a path and a link's target stay", async () => {
  dir("fresh_notes", 8, { fresh: true });
  dir("switchboard.busy.Ab12Cd", 8);
  const child = Bun.spawn(["sleep", "30"], { cwd: join(root, "switchboard.busy.Ab12Cd") });
  try {
    const before = scanTmp(root, NOT_OWNED, Date.now(), FORCE);
    expect(before.cleanable.names.length).toBe(before.forcible.count);
    expect(scanTmp(root, SOMEONE_ELSE, Date.now(), FORCE).forcible).toEqual({ count: 0, bytes: 0 });
    expect(cleanTmp(root, readdirSync(root), SOMEONE_ELSE, Date.now(), FORCE).removed).toEqual([]);
    const c = cleanTmp(root, [...readdirSync(root), "../x", ".."], NOT_OWNED, Date.now(), FORCE);
    expect(c.removed).toContain("fresh_notes");
    expect(c.removed).toContain("switchboard.busy.Ab12Cd");
    expect(c.removed.length).toBe(before.forcible.count);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(c.skipped).toEqual([
      { name: "../x", keep: "name" },
      { name: "..", keep: "name" },
    ]);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("the sweep keeps its own judgment after a manual clean: names of no known kind stay", () => {
  dir("notes", 8);
  expect(cleanTmp(root, ["x.recheck3.a1b2c3"], OWNED, Date.now(), MANUAL_2H).removed).toEqual(["x.recheck3.a1b2c3"]);
  expect(sweepTmp(root, OWNED).removed).toBe(REMOVABLE.length - 1);
  expect(readdirSync(root)).toContain("notes");
  expect(readdirSync(root)).toContain("claude-1001");
});

test.skipIf(process.platform !== "linux")("a directory with a bound Unix socket a running process listens on is in use (a daemon's socket is no path in its fds)", async () => {
  dir("sockdir", 8);
  const server = createServer().listen(join(root, "sockdir", "s.sock"));
  await new Promise((done) => server.once("listening", done));
  try {
    utimesSync(join(root, "sockdir", "s.sock"), OLD, OLD);
    utimesSync(join(root, "sockdir"), OLD, OLD);
    expect(inUse(root)!.has("sockdir")).toBe(true);
    expect(cleanTmp(root, ["sockdir"], NOT_OWNED, Date.now(), MANUAL_2H).skipped).toEqual([{ name: "sockdir", keep: "in-use" }]);
  } finally {
    await new Promise((done) => server.close(done));
  }
  expect(inUse(root)!.has("sockdir")).toBe(false); // closed: nothing listens there any more
});

/** The device number the root itself has; a path `other` names answers one more, as another mount would. */
const MOUNTED = (other: (path: string) => boolean) => (path: string, dev: number) => (other(path) ? dev + 1 : dev);

test("a mount point right under /tmp stays in every mode, and cleanTmp skips it and leaves the directory (#3741)", () => {
  const judge = { ...OWNED, dev: MOUNTED((p) => p === join(root, "foo-abcdef")) };
  for (const mode of [{ kind: "auto" }, { kind: "manual", staleMs: 60_000 }, { kind: "force" }] as const) {
    const r = scanTmp(root, judge, Date.now(), mode);
    expect(r.entries.find((e) => e.name === "foo-abcdef")!.keep).toBe("mount");
    expect(r.cleanable.names).not.toContain("foo-abcdef");
    const c = cleanTmp(root, ["foo-abcdef"], judge, Date.now(), mode);
    expect(c.removed).toEqual([]);
    expect(c.skipped).toEqual([{ name: "foo-abcdef", keep: "mount" }]);
    expect(existsSync(join(root, "foo-abcdef", "sub", "f"))).toBe(true);
  }
});

test("a mount point inside an old directory keeps the whole directory, and nothing in it is entered or removed; the other old ones still go (#3741)", () => {
  const judge = { ...OWNED, dev: MOUNTED((p) => p === join(root, "switchboard.review12.abcDEF", "sub")) };
  const r = scanTmp(root, judge);
  expect(r.entries.find((e) => e.name === "switchboard.review12.abcDEF")!.keep).toBe("mount");
  const c = cleanTmp(root, readdirSync(root), judge);
  expect(c.skipped).toContainEqual({ name: "switchboard.review12.abcDEF", keep: "mount" });
  expect(c.removed.sort()).toEqual(REMOVABLE.filter((n) => n !== "switchboard.review12.abcDEF"));
  expect(existsSync(join(root, "switchboard.review12.abcDEF", "sub", "f"))).toBe(true);
});

test("a mount point right under /tmp is not read into: nothing below it is looked at (#3741)", () => {
  const seen: string[] = [];
  const top = join(root, "foo-abcdef");
  const judge = { ...OWNED, dev: (p: string, d: number) => (seen.push(p), p === top ? d + 1 : d) };
  for (const mode of [{ kind: "auto" }, { kind: "force" }] as const) {
    scanTmp(root, judge, Date.now(), mode);
    cleanTmp(root, ["foo-abcdef"], judge, Date.now(), mode);
  }
  expect(seen.filter((p) => p.startsWith(top + "/"))).toEqual([]);
});

test("a mount point a folder without permissions hid is neither entered nor changed by the permission repair, and keeps the directory (#3741)", () => {
  const entry = join(root, "x.recheck3.a1b2c3");
  const mount = join(entry, "locked", "m");
  mkdirSync(join(mount, "inner"), { recursive: true });
  writeFileSync(join(mount, "inner", "f"), "x");
  utimesSync(join(mount, "inner", "f"), OLD, OLD);
  utimesSync(join(mount, "inner"), OLD, OLD);
  chmodSync(mount, 0o500);
  utimesSync(mount, OLD, OLD);
  chmodSync(join(entry, "locked"), 0o000);
  utimesSync(join(entry, "locked"), OLD, OLD);
  utimesSync(entry, OLD, OLD);
  const seen: string[] = [];
  const judge = { ...OWNED, dev: (p: string, d: number) => (seen.push(p), p === mount ? d + 1 : d) };
  try {
    expect(scanTmp(root, judge).cleanable.names).toContain("x.recheck3.a1b2c3"); // the locked folder hides the mount at first
    const r = cleanTmp(root, ["x.recheck3.a1b2c3"], judge);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([{ name: "x.recheck3.a1b2c3", keep: "mount" }]);
    expect(statSync(mount).mode & 0o777).toBe(0o500); // not made writable
    expect(seen.filter((p) => p.startsWith(mount + "/"))).toEqual([]);
    expect(existsSync(join(mount, "inner", "f"))).toBe(true);
  } finally {
    chmodSync(mount, 0o755);
  }
});
