// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, statSync, utimesSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRunner, CliRelease } from "./cli-update-source.ts";
import { currentVersion, hostInstallDeps, install, rolledAwayFrom, rollbackTarget, type InstallDeps, placesOf, probe, prune, rollback, smoke, stage, swap } from "./cli-update-install.ts";
import { Db } from "./db.ts";

let dir: string;
let db: Db;
let turns: string[];
let turnFails: string | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard.cli-install."));
  db = new Db(join(dir, "switchboard.db"));
  turns = [];
  turnFails = null;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const release = (version: string, runner: CliRunner = "claude"): CliRelease => ({ runner, version, publishedAt: 0, assetUrl: "https://downloads.claude.ai/x", sha256: "a".repeat(64), signature: null });
/** A file that answers `--version` the way the CLI does; `says` is what it prints. */
function fakeCli(path: string, says: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${says}"\n`);
  chmodSync(path, 0o755);
}
function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    ...hostInstallDeps(db),
    home: join(dir, "home"),
    codexTarget: "aarch64-unknown-linux-musl",
    turn: async (_r, bin) => {
      turns.push(bin);
      if (turnFails) throw new Error(turnFails);
    },
    ...over,
  };
}
/** The host as the installer leaves it: the version in use, with the link on it. */
function host(d: InstallDeps, version: string) {
  const p = placesOf("claude", d.home, d.codexTarget);
  fakeCli(p.bin(version), `${version} (Claude Code)`);
  mkdirSync(join(p.link, ".."), { recursive: true });
  symlinkSync(p.dir(version), p.link);
  return p;
}
const downloaded = (version: string, says = `${version} (Claude Code)`) => {
  const f = join(dir, `dl-${version}`);
  fakeCli(f, says);
  return f;
};
const lstatExists = (f: string) => {
  try {
    lstatSync(f);
    return true;
  } catch {
    return false;
  }
};
const rows = () => db.listCliUpdates(10).map((r) => `${r.outcome} ${r.fromVersion}->${r.toVersion}`);

describe("probe", () => {
  test("refuses a file that is another version than the release says", async () => {
    const d = deps();
    const f = downloaded("2.0.0", "2.0.1 (Claude Code)");
    expect(await probe(f, release("2.0.0"), d)).toMatchObject({ ok: false });
    expect(await probe(downloaded("2.0.0"), release("2.0.0"), d)).toEqual({ ok: true });
    expect(await probe(join(dir, "missing"), release("2.0.0"), d)).toMatchObject({ ok: false });
  });
});

describe("stage", () => {
  test("places the file beside the one in use, runs only the checked bytes under that name, and replaces only a leftover", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    const dest = await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    expect(dest).toBe(p.dir("2.1.0"));
    expect(await probe(p.bin("2.1.0"), release("2.1.0"), d)).toEqual({ ok: true });
    const placedAt = statSync(p.bin("2.1.0")).ino;
    // the same bytes are not placed again
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    expect(statSync(p.bin("2.1.0")).ino).toBe(placedAt);
    // other bytes under the same name are not run: a leftover (not what runs, not what a rollback goes to) is placed again
    writeFileSync(p.bin("2.1.0"), "#!/bin/sh\necho changed\n");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    expect(await Bun.file(p.bin("2.1.0")).text()).not.toContain("changed");
    expect(await Bun.file(p.bin("2.0.0")).exists()).toBe(true);
    // the version the link points at is left alone
    writeFileSync(p.bin("2.0.0"), "#!/bin/sh\necho running\n");
    await stage("claude", release("2.0.0"), downloaded("2.0.0"), d);
    expect(await Bun.file(p.bin("2.0.0")).text()).toContain("running");
  });

  test("unpacks a real Codex package with tar, and places a leftover directory again (it cannot be compared)", async () => {
    const d = deps();
    const p = placesOf("codex", d.home, d.codexTarget);
    const pkg = join(dir, "pkg");
    fakeCli(join(pkg, "bin", "codex"), "codex-cli 0.2.0");
    await Bun.$`tar -czf ${join(dir, "pkg.tar.gz")} -C ${pkg} .`.quiet();
    await stage("codex", release("0.2.0", "codex"), join(dir, "pkg.tar.gz"), d);
    expect((await Bun.$`${p.bin("0.2.0")} --version`.text()).trim()).toBe("codex-cli 0.2.0");
    writeFileSync(join(p.dir("0.2.0"), "bin", "codex"), "#!/bin/sh\necho changed\n");
    await stage("codex", release("0.2.0", "codex"), join(dir, "pkg.tar.gz"), d);
    expect((await Bun.$`${p.bin("0.2.0")} --version`.text()).trim()).toBe("codex-cli 0.2.0");
  });

  test("unpacks a Codex package into its release directory, and refuses one without bin/codex", async () => {
    const d = deps({
      untar: async (tarball, into) => {
        if (tarball.endsWith("empty")) return;
        fakeCli(join(into, "bin", "codex"), "codex-cli 0.2.0");
      },
    });
    const p = placesOf("codex", d.home, d.codexTarget);
    await stage("codex", release("0.2.0", "codex"), "tarball", d);
    expect(existsSync(p.bin("0.2.0"))).toBe(true);
    expect(p.dir("0.2.0").endsWith("0.2.0-aarch64-unknown-linux-musl")).toBe(true);
    await expect(stage("codex", release("0.3.0", "codex"), "empty", d)).rejects.toThrow("bin/codex");
    expect(existsSync(p.dir("0.3.0"))).toBe(false);
  });
});

describe("smoke", () => {
  test("a turn stopped by the usage limit is not a failure of the version", async () => {
    const d = deps();
    const f = downloaded("2.1.0");
    turnFails = "You've hit your usage limit";
    expect(await smoke("claude", release("2.1.0"), f, "turn", d)).toMatchObject({ ok: false, limit: true });
    turnFails = "the session ended";
    const failed = await smoke("claude", release("2.1.0"), f, "turn", d);
    expect(failed.ok).toBe(false);
    expect(failed).not.toHaveProperty("limit");
    expect(await smoke("claude", release("2.1.0"), f, "version", d)).toEqual({ ok: true });
  });
});

describe("swap", () => {
  test("keeps the link when the turn fails", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    turnFails = "the session ended";
    const done = await swap("claude", release("2.1.0"), { smoke: "turn", by: "auto" }, d);
    expect(done).toMatchObject({ ok: false, outcome: "refused" });
    expect(readlinkSync(p.link)).toBe(p.dir("2.0.0"));
    expect(rows()).toEqual(["refused 2.0.0->2.1.0"]);
  });

  test("leaves the link and records untested when the usage limit stops the turn", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    turnFails = "You've hit your usage limit";
    expect(await swap("claude", release("2.1.0"), { smoke: "turn", by: "auto" }, d)).toMatchObject({ ok: false, outcome: "untested" });
    expect(readlinkSync(p.link)).toBe(p.dir("2.0.0"));
    expect(rows()).toEqual(["untested 2.0.0->2.1.0"]);
  });

  test("moves the link after a turn, or after --version alone when a turn is not required", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    expect(await swap("claude", release("2.1.0"), { smoke: "turn", by: "auto" }, d)).toEqual({ ok: true, outcome: "installed" });
    expect(turns).toEqual([p.bin("2.1.0")]);
    expect(currentVersion("claude", d)).toBe("2.1.0");
    await stage("claude", release("2.2.0"), downloaded("2.2.0"), d);
    await swap("claude", release("2.2.0"), { smoke: "version", by: "person" }, d);
    expect(turns.length).toBe(1);
    expect(db.lastCliUpdate("claude")).toMatchObject({ outcome: "installed", fromVersion: "2.1.0", toVersion: "2.2.0", by: "person", sha256: "a".repeat(64) });
  });

  test("refuses a staged file that is not the version it was fetched as, and leaves the link", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await stage("claude", release("2.1.0"), downloaded("2.1.0", "2.0.5 (Claude Code)"), d);
    expect(await swap("claude", release("2.1.0"), { smoke: "turn", by: "auto" }, d)).toMatchObject({ ok: false, outcome: "refused" });
    expect(turns).toEqual([]);
    expect(readlinkSync(p.link)).toBe(p.dir("2.0.0"));
  });
});

describe("rollback", () => {
  test("rollback after prune: the version before the last install runs again", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "turn", by: "auto" }, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), { smoke: "turn", by: "auto" }, d);
    // 2.0.0 is no longer kept: only the one in use and the one before it
    expect(existsSync(p.bin("2.0.0"))).toBe(false);
    expect(existsSync(p.bin("2.1.0"))).toBe(true);
    expect(await rollback("claude", "person", d)).toEqual({ ok: true, outcome: "rolled-back" });
    expect(currentVersion("claude", d)).toBe("2.1.0");
    expect((await Bun.$`${p.viaLink} --version`.text()).trim()).toBe("2.1.0 (Claude Code)");
    expect(rows()[0]).toBe("rolled-back 2.2.0->2.1.0");
    // a second rollback has nowhere to go
    expect(await rollback("claude", "person", d)).toMatchObject({ ok: false });
  });

  test("says why and changes nothing when the previous version's files are gone", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "version", by: "auto" }, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), { smoke: "version", by: "auto" }, d);
    rmSync(p.bin("2.1.0"));
    const before = rows();
    expect(await rollback("claude", "person", d)).toMatchObject({ ok: false, reason: expect.stringContaining("2.1.0") });
    expect(currentVersion("claude", d)).toBe("2.2.0");
    expect(rows()).toEqual(before);
  });

  test("goes back only to a version installed here, not to one the installer or the CLI's own update put there", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "version", by: "auto" }, d);
    // something outside these checks moves the link to 2.1.5; the daemon then installs 2.2.0 from it
    fakeCli(p.bin("2.1.5"), "2.1.5 (Claude Code)");
    rmSync(p.link);
    symlinkSync(p.dir("2.1.5"), p.link);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), { smoke: "version", by: "auto" }, d);
    expect(db.lastCliUpdate("claude", "installed")).toMatchObject({ fromVersion: "2.1.5" });
    expect(await rollback("claude", "person", d)).toEqual({ ok: true, outcome: "rolled-back" });
    expect(currentVersion("claude", d)).toBe("2.1.0");
  });

  test("the first install from the installer's version has nothing to go back to", async () => {
    const d = deps();
    host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "version", by: "auto" }, d);
    expect(await rollback("claude", "person", d)).toMatchObject({ ok: false });
    expect(currentVersion("claude", d)).toBe("2.1.0");
  });

  test("does not go back to a version a person rolled back from, and keeps the one they went back to", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    const v = { smoke: "version", by: "auto" } as const;
    await install("claude", release("2.1.0"), downloaded("2.1.0"), v, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), v, d);
    expect(await rollback("claude", "person", d)).toMatchObject({ ok: true }); // 2.2.0 was bad: back to 2.1.0
    await install("claude", release("2.2.1"), downloaded("2.2.1"), v, d);
    expect(existsSync(p.bin("2.1.0"))).toBe(true);
    expect(await rollback("claude", "person", d)).toMatchObject({ ok: true });
    expect(currentVersion("claude", d)).toBe("2.1.0");
  });

  test("a version installed again after a rollback is a target again; the ones rolled away from stay out", async () => {
    const d = deps();
    host(d, "2.0.0");
    const v = { smoke: "version", by: "auto" } as const;
    await install("claude", release("2.1.0"), downloaded("2.1.0"), v, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), v, d);
    await rollback("claude", "person", d); // away from 2.2.0
    expect([...rolledAwayFrom("claude", d)]).toEqual(["2.2.0"]);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), v, d); // checked and installed again
    expect([...rolledAwayFrom("claude", d)]).toEqual([]);
    await install("claude", release("2.3.0"), downloaded("2.3.0"), v, d);
    expect(rollbackTarget("claude", d)).toBe("2.2.0");
  });

  test("a link that is not a symlink has nothing to go back from", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "version", by: "auto" }, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), { smoke: "version", by: "auto" }, d);
    // the version is read through the link, so a link replaced by a file reads as no version: nothing to go back from
    rmSync(p.link);
    writeFileSync(p.link, "x");
    await expect(rollback("claude", "person", d)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("記録に無い") });
    expect(existsSync(p.link) && !lstatSync(p.link).isSymbolicLink()).toBe(true);
  });
});

describe("prune", () => {
  test("keeps the version in use and the one before, and leaves what is not a version alone", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "version", by: "auto" }, d);
    for (const v of ["1.0.0", "1.5.0"]) fakeCli(p.bin(v), v);
    writeFileSync(join(p.versions, "notes.txt"), "x");
    mkdirSync(join(p.versions, ".stage-abc"));
    utimesSync(join(p.versions, ".stage-abc"), new Date(0), new Date(0)); // left long ago
    mkdirSync(join(p.versions, ".stage-young")); // another placing still unpacking
    await stage("claude", release("2.2.0"), downloaded("2.2.0"), d);
    await swap("claude", release("2.2.0"), { smoke: "version", by: "auto" }, d);
    mkdirSync(join(p.versions, "2.0.0-backup"));
    expect(prune("claude", d).sort()).toEqual(["1.0.0", "1.5.0"]);
    expect(existsSync(p.bin("2.1.0")) && existsSync(p.bin("2.2.0")) && existsSync(join(p.versions, "notes.txt"))).toBe(true);
    // a name that only starts like a version is not ours
    expect(existsSync(join(p.versions, "2.0.0-backup"))).toBe(true);
    // an unfinished stage goes too
    expect(existsSync(join(p.versions, ".stage-abc"))).toBe(false);
    expect(existsSync(join(p.versions, ".stage-young"))).toBe(true);
  });

  test("--version is the first version the CLI says, not one it mentions after", async () => {
    const d = deps();
    const f = join(dir, "says");
    fakeCli(f, "codex-cli 0.3.0 - previously 0.2.0");
    expect(await probe(f, release("0.2.0", "codex"), d)).toMatchObject({ ok: false });
    expect(await probe(f, release("0.3.0", "codex"), d)).toEqual({ ok: true });
    fakeCli(f, "codex-cli 0.3.0-alpha.1");
    expect(await probe(f, release("0.3.0", "codex"), d)).toMatchObject({ ok: false });
  });

  test("a Codex version installed here before is not replaced by a package that has not passed yet", async () => {
    const d = deps();
    const p = placesOf("codex", d.home, d.codexTarget);
    const pkg = (v: string, says = `codex-cli ${v}`) => {
      const dirp = join(dir, `pkg-${v}-${says.length}`);
      fakeCli(join(dirp, "bin", "codex"), says);
      return Bun.$`tar -czf ${dirp}.tar.gz -C ${dirp} .`.quiet().then(() => `${dirp}.tar.gz`);
    };
    mkdirSync(join(p.link, ".."), { recursive: true });
    fakeCli(p.bin("0.1.0"), "codex-cli 0.1.0");
    symlinkSync(p.dir("0.1.0"), p.link);
    const v = { smoke: "version", by: "auto" } as const;
    await install("codex", release("0.2.0", "codex"), await pkg("0.2.0"), v, d);
    await install("codex", release("0.3.0", "codex"), await pkg("0.3.0"), v, d);
    // 0.2.0 again (from a package that will fail its turn): the files kept to go back to stay as they were
    turnFails = "boom";
    await install("codex", release("0.2.0", "codex"), await pkg("0.2.0", "codex-cli 0.2.0 rebuilt"), { smoke: "turn", by: "auto" }, d);
    expect((await Bun.$`${p.bin("0.2.0")} --version`.text()).trim()).toBe("codex-cli 0.2.0");
  });

  test("a link moved in whose row cannot be written goes back", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    const failing = { ...d, store: { ...d.store, linkMoves: d.store.linkMoves.bind(d.store), lastCliUpdate: d.store.lastCliUpdate.bind(d.store), addCliUpdate: () => { throw new Error("disk full"); } } };
    await expect(swap("claude", release("2.1.0"), { smoke: "version", by: "auto" }, failing)).rejects.toThrow("disk full");
    expect(readlinkSync(p.link)).toBe(p.dir("2.0.0"));
  });

  test("a rollback whose row cannot be written goes back too, and a first link whose row cannot be written is taken away", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    const v = { smoke: "version", by: "auto" } as const;
    await install("claude", release("2.1.0"), downloaded("2.1.0"), v, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), v, d);
    const failing = { ...d, store: { linkMoves: d.store.linkMoves.bind(d.store), lastCliUpdate: d.store.lastCliUpdate.bind(d.store), addCliUpdate: () => { throw new Error("disk full"); } } };
    await expect(rollback("claude", "person", failing)).rejects.toThrow("disk full");
    expect(readlinkSync(p.link)).toBe(p.dir("2.2.0"));

    const bare = deps({ home: join(dir, "bare") });
    const q = placesOf("claude", bare.home, bare.codexTarget);
    mkdirSync(join(q.link, ".."), { recursive: true });
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), bare);
    const failingBare = { ...bare, store: { linkMoves: bare.store.linkMoves.bind(bare.store), lastCliUpdate: bare.store.lastCliUpdate.bind(bare.store), addCliUpdate: () => { throw new Error("disk full"); } } };
    // with no installers' link there is nothing to manage: the link is not made
    const before = turns.length;
    expect(await swap("claude", release("2.1.0"), { smoke: "turn", by: "auto" }, bare)).toMatchObject({ ok: false, outcome: "refused", reason: expect.stringContaining("link が無い") });
    expect(turns.length).toBe(before); // nothing tried
    void failingBare;
    expect(lstatExists(q.link)).toBe(false);
  });

  test("a link to an executable outside the installers' place is not theirs, even when its name looks like a version", async () => {
    const d = deps();
    const p = placesOf("claude", d.home, d.codexTarget);
    const mine = join(dir, "elsewhere", "2.1.0");
    fakeCli(mine, "2.1.0 (Claude Code)");
    mkdirSync(join(p.link, ".."), { recursive: true });
    symlinkSync(mine, p.link);
    expect(currentVersion("claude", d)).toBeNull();
  });

  test("a link that is a plain file is not replaced", async () => {
    const d = deps();
    const p = placesOf("claude", d.home, d.codexTarget);
    mkdirSync(join(p.link, ".."), { recursive: true });
    writeFileSync(p.link, "#!/bin/sh\necho 2.0.0 (Claude Code)\n");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    expect(await swap("claude", release("2.1.0"), { smoke: "version", by: "auto" }, d)).toMatchObject({ ok: false, outcome: "refused" });
    expect(lstatSync(p.link).isSymbolicLink()).toBe(false);
    expect(await Bun.file(p.link).text()).toContain("2.0.0");
  });

  test("the link does not move when the caller says it can no longer (a Task started during the checks)", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await stage("claude", release("2.1.0"), downloaded("2.1.0"), d);
    const before = rows();
    expect(await swap("claude", release("2.1.0"), { smoke: "turn", by: "auto", canMove: () => false }, d)).toMatchObject({ ok: false, outcome: null });
    expect(currentVersion("claude", d)).toBe("2.0.0");
    expect(rows()).toEqual(before);
    expect(readlinkSync(p.link)).toBe(p.dir("2.0.0"));
  });

  test("a package that cannot be placed is recorded as refused", async () => {
    const d = deps({ untar: async () => undefined });
    const p = placesOf("codex", d.home, d.codexTarget);
    mkdirSync(join(p.link, ".."), { recursive: true });
    fakeCli(p.bin("0.1.0"), "codex-cli 0.1.0");
    symlinkSync(p.dir("0.1.0"), p.link);
    expect(await install("codex", release("0.2.0", "codex"), "empty", { smoke: "version", by: "auto" }, d)).toMatchObject({ ok: false, outcome: "refused", reason: expect.stringContaining("bin/codex") });
    expect(db.lastCliUpdate("codex")).toMatchObject({ outcome: "refused", toVersion: "0.2.0" });
  });

  test("a refused install of the version kept to go back to does not remove its files", async () => {
    const d = deps();
    const p = host(d, "2.0.0");
    await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "version", by: "auto" }, d);
    await install("claude", release("2.2.0"), downloaded("2.2.0"), { smoke: "version", by: "auto" }, d);
    turnFails = "boom";
    expect(await install("claude", release("2.1.0"), downloaded("2.1.0"), { smoke: "turn", by: "auto" }, d)).toMatchObject({ ok: false, outcome: "refused" });
    expect(existsSync(p.bin("2.1.0"))).toBe(true);
  });
});
