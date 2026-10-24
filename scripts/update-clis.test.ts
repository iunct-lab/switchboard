import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, VersionReaders } from "./check-models";
import { hostDeps, requestFor, updateClis, type UpdateDeps } from "./update-clis";

let dir: string;
let links: Record<Runner, string>;

/** A CLI whose `--version` prints the version of the directory it is a symlink to, like the real layout. */
function fakeCli(root: string, runner: string, versions: string[]) {
  for (const v of versions) {
    mkdirSync(join(root, runner, v), { recursive: true });
    const bin = join(root, runner, v, "cli");
    writeFileSync(bin, `#!/bin/sh\necho "${v}"\n`);
    chmodSync(bin, 0o755);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard.update-clis.test."));
  fakeCli(dir, "claude", ["1.0.0", "1.1.0"]);
  fakeCli(dir, "codex", ["2.0.0", "2.1.0"]);
  symlinkSync(join(dir, "claude", "1.0.0", "cli"), join(dir, "claude-link"));
  symlinkSync(join(dir, "codex", "2.1.0", "cli"), join(dir, "codex-link"));
  links = { claude: join(dir, "claude-link"), codex: join(dir, "codex-link") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function installedFrom(link: string): Promise<string> {
  const p = Bun.spawn([link], { stdout: "pipe" });
  return (await new Response(p.stdout).text()).trim();
}

function deps(over: Partial<UpdateDeps> & { latest?: Partial<Record<Runner, string | Error>> } = {}): UpdateDeps & { updated: Runner[] } {
  const latest = { claude: "1.1.0", codex: "2.1.0", ...over.latest } as Record<Runner, string | Error>;
  const base = hostDeps();
  const updated: Runner[] = [];
  const versions: VersionReaders = {
    installed: (r) => installedFrom(links[r]),
    async latest(r) {
      const v = latest[r]!;
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return {
    versions,
    // The fake `claude update`: flips the symlink to 1.1.0.
    async update(r) {
      updated.push(r);
      base.swapLink(links[r], join(dir, r, "1.1.0", "cli"));
      return { code: 0, out: "" };
    },
    async smoke() {},
    readLink: base.readLink,
    swapLink: base.swapLink,
    ...over,
    updated,
  } as UpdateDeps & { updated: Runner[] };
}

describe("updateClis", () => {
  test("updates an outdated CLI and prints both versions", async () => {
    const d = deps();
    const r = await updateClis(d, links);
    expect(r.lines).toEqual(["claude updated: 1.0.0 → 1.1.0（確認 ok）", "codex version: 2.1.0（最新）"]);
    expect(r.code).toBe(0);
    expect(readlinkSync(links.claude)).toBe(join(dir, "claude", "1.1.0", "cli"));
  });

  test("rolls back when the turn fails", async () => {
    const d = deps({ smoke: async () => { throw new Error("no answer"); } });
    const r = await updateClis(d, links);
    expect(r.lines[0]).toBe("claude rolled back: 1.1.0 → 1.0.0（確認 失敗: 1 ターンが通らない: no answer）");
    expect(readlinkSync(links.claude)).toBe(join(dir, "claude", "1.0.0", "cli"));
    expect(await installedFrom(links.claude)).toBe("1.0.0");
    expect(r.code).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.restored).toBe(true);
  });

  test("rolls back when update leaves the version unchanged", async () => {
    const d = deps({ update: async () => ({ code: 0, out: "" }) });
    const r = await updateClis(d, links);
    expect(r.lines[0]).toContain("claude rolled back: 1.1.0 → 1.0.0");
    expect(r.lines[0]).toContain("版が 1.0.0 のまま");
    expect(await installedFrom(links.claude)).toBe("1.0.0");
    expect(r.code).toBe(1);
  });

  test("rolls back when update fails after moving the link", async () => {
    const base = hostDeps();
    const d = deps({ update: async () => (base.swapLink(links.claude, join(dir, "claude", "1.1.0", "cli")), { code: 1, out: "boom\n" }) });
    const r = await updateClis(d, links);
    expect(r.lines[0]).toContain("update が exit 1: boom");
    expect(await installedFrom(links.claude)).toBe("1.0.0");
  });

  test("does nothing when up to date", async () => {
    const d = deps({ latest: { claude: "1.0.0" } });
    const r = await updateClis(d, links);
    expect(r.lines).toEqual(["claude version: 1.0.0（最新）", "codex version: 2.1.0（最新）"]);
    expect(d.updated).toEqual([]);
    expect(r.code).toBe(0);
  });

  test("cannot tell without the registry", async () => {
    const d = deps({ latest: { claude: new Error("registry.npmjs.org answered 503") } });
    const r = await updateClis(d, links);
    expect(r.lines[0]).toBe("claude latest: 分からない（registry.npmjs.org answered 503）");
    expect(r.code).toBe(2);
    expect(d.updated).toEqual([]);
  });

  test("reports a rollback that did not take", async () => {
    const d = deps({
      smoke: async () => { throw new Error("x"); },
      swapLink: () => { throw new Error("read-only"); },
    });
    const r = await updateClis(d, links);
    expect(r.lines[0]).toContain("claude 戻せなかった");
    expect(r.failures[0]!.restored).toBe(false);
    expect(r.code).toBe(1);
  });

  test("files the same title for the same failure", async () => {
    const run = async () => {
      const d = deps({ smoke: async () => { throw new Error("x"); } });
      const r = await updateClis(d, links);
      return requestFor(r.failures, "2026-10-16", r.lines)!.title;
    };
    const first = await run();
    expect(await run()).toBe(first);
    expect(first).toBe("CLI 更新の失敗: claude 1.0.0 → 1.1.0");
  });

  test("puts the link back when the update leaves it dangling", async () => {
    const d = deps({ update: async () => (rmSync(links.claude), symlinkSync(join(dir, "claude", "gone"), links.claude), { code: 1, out: "boom" }) });
    const r = await updateClis(d, links);
    expect(r.failures[0]!.restored).toBe(true);
    expect(await installedFrom(links.claude)).toBe("1.0.0");
  });

  test("reports the version that was actually installed, not npm's latest", async () => {
    const d = deps({ latest: { claude: "1.2.0" }, smoke: async () => { throw new Error("x"); } });
    const r = await updateClis(d, links);
    expect(r.lines[0]).toContain("rolled back: 1.1.0 → 1.0.0");
    expect(r.failures[0]!.to).toBe("1.1.0");
  });

  test("reports the installed version when update exits non-zero after installing", async () => {
    const base = hostDeps();
    const d = deps({ latest: { claude: "1.2.0" }, update: async () => (base.swapLink(links.claude, join(dir, "claude", "1.1.0", "cli")), { code: 1, out: "boom" }) });
    const r = await updateClis(d, links);
    expect(r.failures[0]!.to).toBe("1.1.0");
  });

  test("the Issue body carries no home path", () => {
    const home = homedir();
    const f = { runner: "claude" as const, from: "1.0.0", to: "1.1.0", reason: "x", restored: false };
    const body = requestFor([f], "2026-10-16", [`claude 戻せなかった: ${home}/.local/bin/claude`])!.body;
    expect(body).not.toContain(home);
  });
});
