// test-reads: ops-kit/template/ops.config.json
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config.ts";
import { buildBody, depsCheck, directDeps, excludeFiled, findUvDirs, judge, newerVersion, parseBunAudit, parseBunOutdated, parsePipAudit, parseUvUpgrade, STALE_DAYS, titleOf, type Dep, type DepsCheckDeps, type OpenPr } from "./deps-check.ts";
import { checkRequestBody } from "./request.ts";
import { openLockPrs } from "./deps-check-io.ts";
import { fakeGh, type FakeCall } from "./gh.ts";

// output of `bun outdated --filter '*'` / `bun audit --json` (the rows are shortened by hand)
const OUTDATED = `bun outdated v1.4.4 (38afee6c8)
|-------------------------------------------------------------------|
| Package                    | Current  | Update   | Latest   | Workspace |
|----------------------------|----------|----------|----------|-----------|
| @aws-sdk/client-s3         | 3.1161.0 | 3.1166.0 | 3.1166.0 | aws       |
|----------------------------|----------|----------|----------|-----------|
| typescript (dev)           | 5.9.3    | 5.9.3    | 7.0.2    | root      |
|----------------------------|----------|----------|----------|-----------|
| vite (dev)                 | 8.3.5    | 8.3.7    | 8.3.7    | web       |
|----------------------------|----------|----------|----------|-----------|
| zod                        | 4.6.7    | 4.6.7    | 4.6.7    | root      |
|-------------------------------------------------------------------|
`;
const OUTDATED_NO_WORKSPACE = OUTDATED.replace(/ \| (aws|root|web|Workspace) +\|/g, " |").replace(/-----------\|/g, "|");
const AUDIT = JSON.stringify({ minimist: [{ id: 1096465, url: "https://github.com/advisories/GHSA-vh95-rmgr-6w4m", title: "Prototype Pollution in minimist", severity: "critical", vulnerable_versions: "<0.2.4", cwe: ["CWE-1321"], cvss: { score: 9.8 } }] });
const NOW = new Date("2026-11-10T12:00:00");

test("bun outdated: the table of rows with a Workspace column, (dev) dropped, up-to-date rows left out", () => {
  expect(parseBunOutdated(OUTDATED)).toEqual([
    { dir: "aws", name: "@aws-sdk/client-s3", current: "3.1161.0", latest: "3.1166.0" },
    { dir: "root", name: "typescript", current: "5.9.3", latest: "7.0.2" },
    { dir: "web", name: "vite", current: "8.3.5", latest: "8.3.7" },
  ]);
  expect(parseBunOutdated(OUTDATED_NO_WORKSPACE).map((r) => r.dir)).toEqual([".", ".", "."]);
  expect(parseBunOutdated("bun outdated v1.4.4\n")).toEqual([]);
});

test("bun audit --json: one finding per advisory; anything else throws", () => {
  expect(parseBunAudit(AUDIT)).toEqual([{ name: "minimist", severity: "critical", title: "Prototype Pollution in minimist", id: "GHSA-vh95-rmgr-6w4m" }]);
  expect(parseBunAudit("{}")).toEqual([]);
  expect(() => parseBunAudit("No vulnerabilities found")).toThrow();
});

const dep = (o: Partial<Dep>): Dep => ({ dir: ".", name: "p", current: "1.0.0", candidate: "1.0.1", reason: "", published: "2026-11-01", license: "MIT", ...o });

test("judge: a vulnerability, a major behind, a current version 90 days old; a patch of a fresh version is not a hit", () => {
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const published = { "old@1.0.0": day(STALE_DAYS).slice(0, 10), "fresh@1.0.0": day(STALE_DAYS - 5).slice(0, 10), "big@1.0.0": day(1).slice(0, 10), "vuln@1.0.0": day(1).slice(0, 10) };
  const got = judge([dep({ name: "old" }), dep({ name: "fresh" }), dep({ name: "big", candidate: "2.0.0" }), dep({ name: "vuln" })], [{ name: "vuln", severity: "high", title: "t", id: "GHSA-x" }, { name: "gone", severity: "low", title: "t", id: "GHSA-y" }], NOW, published);
  expect(got.hit).toBe(true);
  expect(got.rows.map((r) => [r.name, r.reason])).toEqual([
    ["old", `outdated（現在の版の公開から ${STALE_DAYS} 日）`],
    ["big", "outdated（major の遅れ）"],
    ["vuln", "脆弱性 GHSA-x（high）"],
    ["gone", "脆弱性 GHSA-y（low）"],
  ]);
  expect(got.rows.find((r) => r.name === "gone")).toMatchObject({ current: "-", candidate: "-" });
  expect(judge([dep({ name: "fresh" })], [], NOW, published)).toEqual({ hit: false, rows: [] });
});

test("an open PR that moves the package to a later version takes it out of the table", () => {
  const f = (patch: string, path = "bun.lock") => ({ path, patch });
  const prs: OpenPr[] = [
    { number: 7, files: [f('@@ -1 +1 @@\n-    "vite": "^8.3.5",\n+    "vite": "^8.3.7",\n+++ b/x', "package.json")] },
    { number: 8, files: [f(' "typescript": "5.9.3"')] },
    // a nested bun.lock entry whose value is vite at a later version handles vite (here: PR 10)
    { number: 10, files: [f('+    "foo/vite": ["vite@8.3.7", "", {}, "sha512-c"],')] },
    // another package's bun.lock entry that only depends on typescript does not handle typescript
    { number: 9, files: [f('-    "foo": ["foo@1.0.0", "", { "dependencies": { "typescript": "5.9.3" } }, "sha512-a"],\n+    "foo": ["foo@1.0.1", "", { "dependencies": { "typescript": "5.9.3" } }, "sha512-b"],')] },
    // a new workspace that adds typescript at the current version does not handle it
    { number: 11, files: [f('+    "typescript": "^5.9.3",', "apps/new/package.json")] },
    // a file this ecosystem does not read
    { number: 12, files: [f('+    "typescript": "^7.0.2",', "notes.txt")] },
  ];
  const rows = [dep({ name: "vite", current: "8.3.5" }), dep({ name: "typescript", current: "5.9.3" })];
  const got = excludeFiled(rows, prs);
  expect(got.rows.map((r) => r.name)).toEqual(["typescript"]);
  expect(got.filed).toEqual([{ name: "vite", prs: [7, 10] }]);
  expect(newerVersion("^8.3.7", "8.3.5")).toBe(true);
  expect(newerVersion("8.3.5", "8.3.5")).toBe(false);
  expect(newerVersion("8.10.0", "8.9.9")).toBe(true);
  // same numbers: the suffix decides — prerelease < release < post release, and the number within the same kind
  expect(newerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
  // SemVer (bun): prerelease identifiers by ASCII, numbers before words
  expect(newerVersion("1.0.0-beta.1", "1.0.0-dev.1")).toBe(false);
  expect(newerVersion("1.0.0-alpha.beta", "1.0.0-alpha.1")).toBe(true);
  expect(newerVersion("1.0.0-beta.1", "1.0.0-beta.2")).toBe(false);
  expect(newerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
  expect(newerVersion("^1.0.0", "1.0.0")).toBe(false);
  expect(newerVersion("1.0.0", "1.0")).toBe(false);
  expect(newerVersion("1.0.0-beta.1.9", "1.0.0-beta.2.1")).toBe(false);
  expect(newerVersion("1.0.0-beta.2.1", "1.0.0-beta.2")).toBe(true);
  expect(newerVersion("1.0.0+build.2", "1.0.0+build.1")).toBe(false);
  // a row of another package manager is not handled through bun's files
  expect(excludeFiled([dep({ name: "vite", current: "8.3.5", tool: "uv" })], prs).rows.length).toBe(1);
});

test("judge: 0.x → 0.y is a major behind (semver), 0.25.0 → 0.25.3 is not", () => {
  const fresh = { "z@0.25.0": new Date(NOW.getTime() - 86_400_000).toISOString() };
  const got = judge([dep({ name: "z", current: "0.25.0", candidate: "0.26.0" }), dep({ name: "y", current: "0.25.0", candidate: "0.25.3" })], [], NOW, { ...fresh, "y@0.25.0": fresh["z@0.25.0"]! });
  expect(got.rows.map((r) => `${r.name} ${r.reason}`)).toEqual(["z outdated（major の遅れ）"]);
});

const source = { now: NOW, audits: ["bun audit の終了コード 0（脆弱性 0 件）"], filed: [{ name: "vite", prs: [7] }], prsRead: true };

test("the body: 要望 / 出典 / 更新の条件, the tool's sentence then extraConditions; it passes the request's lint", () => {
  const rows = [dep({ name: "typescript", reason: "outdated（major の遅れ）" })];
  const plain = buildBody(rows, source, ["tool sentence"]);
  const extra = buildBody(rows, source, ["tool sentence", "repo sentence"]);
  expect(plain).toContain("| . | typescript | 1.0.0 | 1.0.1 | outdated（major の遅れ） | 2026-11-01 | MIT |");
  expect(plain).toContain("既出: vite（#7 が扱っている）");
  expect(plain.split("## 更新の条件")[1]).toBe("\n\n- tool sentence\n");
  expect(extra.split("## 更新の条件")[1]).toBe("\n\n- tool sentence\n- repo sentence\n");
  expect(buildBody(rows, { ...source, prsRead: false }, [])).toContain("既出の確認なし");
  const dir = mkdtempSync(join(tmpdir(), "deps-check.test."));
  try {
    writeFileSync(join(dir, "b.md"), plain);
    const cfg = parseConfig(JSON.parse(require("node:fs").readFileSync(join(import.meta.dir, "../template/ops.config.json"), "utf8").replaceAll("__AREA__", "app").replaceAll("__PREFIX__", "X")));
    expect(() => checkRequestBody(cfg, join(dir, "b.md"))).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("depsCheck.extraConditions is optional in the config", () => {
  const base = JSON.parse(require("node:fs").readFileSync(join(import.meta.dir, "../template/ops.config.json"), "utf8").replaceAll("__AREA__", "app").replaceAll("__PREFIX__", "X"));
  expect(parseConfig(base).depsCheck).toBeUndefined();
  expect(parseConfig({ ...base, depsCheck: { extraConditions: ["a"] } }).depsCheck?.extraConditions).toEqual(["a"]);
  expect(() => parseConfig({ ...base, depsCheck: { extraConditions: [""] } })).toThrow();
});

// a repository with bun.lock, tools answering with the fixtures, and a fake backlog that records what was done
function fake(o: { audit?: string; auditCode?: number; outdated?: string; open?: Array<{ ref: string; title: string }>; prs?: OpenPr[] | null; toolCode?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deps-check.test."));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bun.lock"), "");
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const times = JSON.stringify({ "5.9.3": "2025-10-01T00:00:00.000Z", "7.0.2": "2026-07-08T00:00:00.000Z", "8.3.5": "2026-10-20T00:00:00.000Z", "3.1161.0": "2026-10-30T00:00:00.000Z", "3.1166.0": "2026-11-05T00:00:00.000Z", "8.3.7": "2026-11-05T00:00:00.000Z" });
  const deps: DepsCheckDeps = {
    cwd: dir,
    fetchJson: async () => null,
    now: () => NOW,
    exec: async (cmd) => {
      if (o.toolCode) return { out: "", code: o.toolCode };
      if (cmd[1] === "audit") return { out: o.audit ?? "{}", code: o.auditCode ?? 0 };
      if (cmd[1] === "outdated") return { out: o.outdated ?? OUTDATED, code: 0 };
      return { out: cmd[3] === "time" ? times : '"MIT"', code: 0 };
    },
    openPrs: async () => (o.prs === undefined ? [] : o.prs),
    openRequests: async () => o.open ?? [],
    fileRequest: async (title, body) => (log.push(`file ${title}`, body), "#99"),
    comment: async (ref, body) => void log.push(`comment ${ref}`, body),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  return { deps, log, out, err, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("exit 1 with the table, no request without --file-request", async () => {
  const f = fake();
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
  expect(f.out.join("\n")).toContain("| root | typescript | 5.9.3 | 7.0.2 | outdated（major の遅れ）、outdated（現在の版の公開から 405 日） | 2026-07-08 | MIT |");
  expect(f.out.join("\n")).not.toContain("vite");
  expect(f.log).toEqual([]);
  f.done();
});

test("exit 0 and 要望: 当たらない when nothing meets a condition", async () => {
  const f = fake({ outdated: "bun outdated v1.4.4\n" });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, f.deps)).toBe(0);
  expect(f.out.at(-1)).toBe("要望: 当たらないので起票しない");
  expect(f.log).toEqual([]);
  f.done();
});

test("--file-request: files a request with the month's title, with extraConditions in the body", async () => {
  const f = fake({ audit: AUDIT, auditCode: 1 });
  expect(await depsCheck({ fileRequest: true, extraConditions: ["repo sentence"] }, f.deps)).toBe(1);
  expect(f.log[0]).toBe("file 依存の更新: 2026-11");
  expect(f.log[1]).toContain("脆弱性 GHSA-vh95-rmgr-6w4m（critical）");
  expect(f.log[1]).toContain("- repo sentence");
  expect(f.log[1]).toContain("bun audit の終了コード 1（脆弱性 1 件）");
  expect(f.out.at(-1)).toBe("要望: 起票した #99");
  f.done();
});

test("--file-request: an open request with the same title gets a comment instead", async () => {
  const f = fake({ open: [{ ref: "#12", title: titleOf(NOW) }, { ref: "#13", title: "依存の更新: 2026-10" }] });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, f.deps)).toBe(1);
  expect(f.log[0]).toBe("comment #12");
  expect(f.out.at(-1)).toBe("要望: 開いた要望 #12 に足した");
  f.done();
});

test("a package an open PR handles is listed as 既出 and, when it was the only one, nothing is filed", async () => {
  const f = fake({ prs: [{ number: 5, files: [{ path: "package.json", patch: '-    "typescript": "5.9.3",\n+    "typescript": "7.0.2",' }] }] });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, f.deps)).toBe(0);
  expect(f.out.join("\n")).toContain("既出 1 件");
  expect(f.out.join("\n")).toContain("既出: typescript（#5 が扱っている）");
  expect(f.out.at(-1)).toBe("要望: 当たらないので起票しない");
  f.done();
});

test("open PRs that cannot be read: 既出の確認なし in the body", async () => {
  const f = fake({ prs: null });
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
  expect(f.out.join("\n")).toContain("既出の確認なし");
  f.done();
});

test("exit 2 when a tool did not run, or there is no lockfile; nothing is filed", async () => {
  const failed = fake({ toolCode: 3 });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, failed.deps)).toBe(2);
  expect(failed.err[0]).toContain("道具が走らなかった");
  expect(failed.log).toEqual([]);
  const garbled = fake({ audit: "error: network" });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, garbled.deps)).toBe(2);
  // the publication dates could not be read: not a condition by itself (nothing else meets one here: exit 0), but named
  const noDates = fake({ outdated: OUTDATED.split("\n").filter((l) => !l.includes("typescript")).join("\n") });
  const exec = noDates.deps.exec;
  noDates.deps.exec = async (cmd) => (cmd[1] === "info" && cmd[3] === "time" ? { out: "", code: 1 } : exec(cmd));
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, noDates.deps)).toBe(0);
  expect(noDates.out).toContain("今の版の公開日が読めず 90 日の判定をしていない: aws/@aws-sdk/client-s3、web/vite");
  expect(noDates.log).toEqual([]);
  noDates.done();
  // with another row that meets a condition, the line goes into the body's 出典 too
  const noCurrent = fake();
  const exec2 = noCurrent.deps.exec;
  noCurrent.deps.exec = async (cmd) => (cmd[1] === "info" && cmd[3] === "time" ? { out: "{}", code: 0 } : exec2(cmd));
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, noCurrent.deps)).toBe(1);
  expect(noCurrent.out.join("\n")).toContain("- 検査: 今の版の公開日が読めず 90 日の判定をしていない: aws/@aws-sdk/client-s3、root/typescript、web/vite");
  noCurrent.done();
  const none = fake();
  const empty = mkdtempSync(join(tmpdir(), "deps-check.empty."));
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, { ...none.deps, cwd: empty })).toBe(2);
  rmSync(empty, { recursive: true, force: true });
  failed.done();
  garbled.done();
  none.done();
});

test("open PRs: every page of the PRs and of each PR's files", async () => {
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ number: from + i }));
  const files = (n: number, last: { filename: string; patch: string } | null) => [...Array.from({ length: n }, (_, i) => ({ filename: `f${i}.ts`, patch: "" })), ...(last ? [last] : [])];
  const responses: Array<(c: FakeCall) => unknown> = [() => page(100, 1), () => page(1, 101)];
  for (let n = 1; n <= 101; n++) {
    if (n === 101) responses.push(() => files(100, null), () => files(0, { filename: "bun.lock", patch: '+    "vite": "x",' }));
    else responses.push(() => []);
  }
  const gh = fakeGh(responses);
  const got = await openLockPrs(gh, { GH_REPO: "o/r" }, tmpdir());
  expect(got).toEqual([{ number: 101, files: [{ path: "bun.lock", patch: '+    "vite": "x",' }] }]);
  expect((gh.calls[1] as { path: string }).path).toBe("repos/o/r/pulls?state=open&per_page=100&page=2");
});

test("open PRs: a lockfile whose patch GitHub left out (too large) is named; the PR's other files are still read", async () => {
  const gh = fakeGh([() => [{ number: 1 }], () => [{ filename: "bun.lock" }, { filename: "package.json", patch: '+    "vite": "^8.3.7",' }]]);
  expect(await openLockPrs(gh, { GH_REPO: "o/r" }, tmpdir())).toEqual([{ number: 1, files: [{ path: "package.json", patch: '+    "vite": "^8.3.7",' }], unread: ["bun.lock"] }]);
});

test("a row with a vulnerability stays even when an open PR moves the package; an unread file is named in the body", async () => {
  const f = fake({ audit: AUDIT, auditCode: 1, prs: [{ number: 5, files: [{ path: "package.json", patch: '+    "typescript": "^7.0.2",' }, { path: "bun.lock", patch: '+    "x/minimist": ["minimist@0.0.8", "", {}, "sha512-a"],' }], unread: ["apps/web/bun.lock"] }] });
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
  const text = f.out.join("\n");
  // the PR adds minimist (still vulnerable) through a nested entry: the vulnerability row stays
  expect(text).toContain("| . | minimist | - | - | 脆弱性 GHSA-vh95-rmgr-6w4m（critical）");
  expect(text).toContain("既出: typescript（#5 が扱っている）");
  expect(text).toContain("既出の確認が一部できない: #5 の apps/web/bun.lock（GitHub が差分を省いた）。");
  f.done();
});

// --- uv: output of `uv lock --upgrade --dry-run` / `pip-audit -f json` (shortened by hand)
const UV_UPGRADE = `Using CPython 3.14.10
Resolved 28 packages in 110ms
Update certifi v2026.10.19 -> v2026.10.23
Update pydantic v2.13.5 -> v3.0.0
Update pytest v9.1.1 -> v9.2.0
Update starlette v1.7.0 -> v1.7.0, v1.10.0
Add mmh3 v5.3.1
Remove shellingham v1.5.4
`;
const PIP_AUDIT = JSON.stringify({ dependencies: [{ name: "pytest", version: "9.1.1", vulns: [{ id: "PYSEC-2026-1", fix_versions: ["9.2.0"], aliases: ["CVE-2026-0001"], description: "d" }] }, { name: "certifi", version: "2026.10.19", vulns: [] }], fixes: [] });
// `info` is the latest release (the last version given)
const pypi = (versions: Record<string, string>, license = "MIT") => ({ info: { version: Object.keys(versions).at(-1), license_expression: license }, releases: Object.fromEntries(Object.entries(versions).map(([v, d]) => [v, [{ upload_time_iso_8601: `${d}T10:00:00.000000Z` }]])) });
const PYPI: Record<string, unknown> = {
  "https://pypi.org/pypi/certifi/json": pypi({ "2026.10.19": "2026-10-19", "2026.10.23": "2026-10-23" }),
  "https://pypi.org/pypi/pydantic/json": pypi({ "2.13.5": "2026-09-01", "3.0.0": "2026-11-05" }, "x".repeat(80)),
  "https://pypi.org/pypi/starlette/json": pypi({ "1.7.0": "2026-09-20", "1.10.0": "2026-11-02" }),
  "https://pypi.org/pypi/pytest/json": pypi({ "9.1.1": "2026-10-25", "9.2.0": "2026-11-01" }),
};

const BUN_TIMES = JSON.stringify({ "5.9.3": "2025-10-01T00:00:00.000Z", "7.0.2": "2026-07-08T00:00:00.000Z", "8.3.5": "2026-10-20T00:00:00.000Z", "8.3.7": "2026-11-05T00:00:00.000Z", "3.1161.0": "2026-10-30T00:00:00.000Z", "3.1166.0": "2026-11-05T00:00:00.000Z" });

// uv.lock in `.` and in `svc/api`; one in node_modules / .venv that must not be read
function fakeUv(o: { pipAudit?: "ok" | "missing" | "garbled" | "exit2"; upgrade?: Record<string, string>; bun?: boolean; fetched?: string[]; pyproject?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deps-check.test."));
  for (const d of [".", "svc/api", "node_modules/x", ".venv/lib"]) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, "uv.lock"), "");
    if (o.pyproject !== null) writeFileSync(join(dir, d, "pyproject.toml"), o.pyproject ?? '[project]\nname = "x"\ndependencies = ["certifi", "Pydantic>=2", "starlette"]\n[dependency-groups]\ndev = ["pytest"]\n');
  }
  if (o.bun) writeFileSync(join(dir, "bun.lock"), "");
  const calls: string[] = [];
  const out: string[] = [];
  const deps: DepsCheckDeps = {
    cwd: dir,
    now: () => NOW,
    fetchJson: async (url) => (o.fetched?.push(url), PYPI[url] ?? null),
    exec: async (cmd, opts) => {
      const at = (opts?.cwd ?? "").slice(dir.length + 1) || ".";
      calls.push(`${at}: ${cmd.slice(0, 3).join(" ")}`);
      if (cmd[0] === "bun") return { out: cmd[1] === "audit" ? "{}" : cmd[1] === "outdated" ? OUTDATED : cmd[3] === "time" ? BUN_TIMES : '"MIT"', code: 0 };
      if (cmd[1] === "lock" && cmd[2] === "--check") return { out: "", code: 0 };
      if (cmd[1] === "lock") return { out: o.upgrade?.[at] ?? UV_UPGRADE, code: 0 };
      if (cmd[1] === "export") return { out: "pytest==9.1.1\n", code: 0 };
      if (o.pipAudit === "missing") throw new Error("ENOENT uvx");
      if (o.pipAudit === "exit2") return { out: "", code: 2 };
      if (o.pipAudit === "garbled") return { out: "error", code: 0 };
      expect(opts?.stdin).toBe("pytest==9.1.1\n");
      return { out: at === "." ? PIP_AUDIT : '{"dependencies": []}', code: at === "." ? 1 : 0 };
    },
    openPrs: async () => [],
    openRequests: async () => [],
    fileRequest: async () => "#1",
    comment: async () => {},
    out: (s) => out.push(s),
    err: () => {},
  };
  return { deps, calls, out, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("uv: findUvDirs finds every uv.lock but not under node_modules / .venv / .git", () => {
  const f = fakeUv();
  expect(findUvDirs(f.deps.cwd)).toEqual([".", "svc/api"]);
  f.done();
});

test("uv: the Update lines of uv lock --upgrade --dry-run; pip-audit's JSON gives one finding per vulnerability", () => {
  expect(parseUvUpgrade(UV_UPGRADE)).toEqual([
    { name: "certifi", current: "2026.10.19", latest: "2026.10.23" },
    { name: "pydantic", current: "2.13.5", latest: "3.0.0" },
    { name: "pytest", current: "9.1.1", latest: "9.2.0" },
    { name: "starlette", current: "1.7.0", latest: "1.10.0" },
  ]);
  expect(parseUvUpgrade("Resolved 3 packages in 1ms\n")).toEqual([]);
  // output it cannot read: a throw (exit 2), not "nothing to update"
  expect(() => parseUvUpgrade("")).toThrow("Resolved の行が無い");
  // one version per Python-version fork on each side: a row per fork, so the major of the second is not missed
  expect(parseUvUpgrade("Resolved 9 packages in 5ms\nUpdate pydantic v1.10.0, v2.13.5 -> v1.10.26, v3.0.0\n")).toEqual([
    { name: "pydantic", current: "1.10.0", latest: "1.10.26" },
    { name: "pydantic", current: "2.13.5", latest: "3.0.0" },
  ]);
  expect(parsePipAudit(PIP_AUDIT, "cli")).toEqual([{ name: "pytest", severity: "修正版 9.2.0", title: "d", id: "PYSEC-2026-1", dir: "cli" }]);
  expect(() => parsePipAudit("error")).toThrow();
});

test("uv: the table by directory with the PyPI dates, a vulnerability only in the directory that has it, exit 1", async () => {
  const fetched: string[] = [];
  const f = fakeUv({ fetched });
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
  const text = f.out.join("\n");
  expect(text).toContain("| . | pytest | 9.1.1 | 9.2.0 | 脆弱性 PYSEC-2026-1（修正版 9.2.0） | 2026-11-01 | MIT |");
  expect(text).toContain("| . | pydantic | 2.13.5 | 3.0.0 | outdated（major の遅れ） | 2026-11-05 | 不明 |");
  expect(text).toContain("| svc/api | pydantic | 2.13.5 | 3.0.0 | outdated（major の遅れ） | 2026-11-05 | 不明 |");
  expect(text).not.toMatch(/\| svc\/api \| pytest/);
  expect(text).toContain("- 検査: pip-audit: 脆弱性 1 件");
  expect(text).toContain("## 更新の条件\n\n- 候補の版は公開から 7 日以上経ったものだけ。uv.lock と pyproject.toml 以外は触らない。");
  expect(f.calls.filter((c) => c.startsWith("svc/api"))).toEqual(["svc/api: uv lock --check", "svc/api: uv lock --upgrade", "svc/api: uv export --frozen", "svc/api: uvx pip-audit -r"]);
  expect(f.calls.some((c) => c.includes("node_modules") || c.includes(".venv"))).toBe(false);
  expect(fetched.length).toBe(4); // one read of PyPI per package, not per directory
  f.done();
});

test("uv: pip-audit did not run (missing, garbled, exit 2): one line says so and outdated alone decides", async () => {
  for (const pipAudit of ["missing", "garbled", "exit2"] as const) {
    const f = fakeUv({ pipAudit });
    expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
    expect(f.out.filter((s) => s.startsWith("pip-audit が走らなかった"))).toEqual(["pip-audit が走らなかった（.、svc/api）。そのディレクトリの脆弱性は検査せず、outdated だけで判定する"]);
    expect(f.out.join("\n")).not.toContain("PYSEC");
    expect(f.out.join("\n")).toContain("outdated（major の遅れ）");
    f.done();
  }
  // it ran in one directory and not in the other: only the other is named, and the vulnerability found stays
  const half = fakeUv();
  const exec = half.deps.exec;
  const deps = { ...half.deps, exec: async (cmd: string[], o?: Parameters<typeof exec>[1]) => (cmd[0] === "uvx" && o?.cwd?.endsWith("svc/api") ? { out: "", code: 2 } : exec(cmd, o)) };
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, deps)).toBe(1);
  const text = half.out.join("\n");
  expect(half.out.filter((s) => s.startsWith("pip-audit が走らなかった"))).toEqual(["pip-audit が走らなかった（svc/api）。そのディレクトリの脆弱性は検査せず、outdated だけで判定する"]);
  expect(text).toContain("脆弱性 PYSEC-2026-1");
  expect(text).toContain("- 検査: pip-audit: 脆弱性 1 件、pip-audit: 走らなかった（svc/api）");
  half.done();
  // nothing outdated and no audit: exit 0, not a failure
  const quiet = fakeUv({ pipAudit: "missing", upgrade: { ".": "Resolved 1 package in 1ms\n", "svc/api": "Resolved 1 package in 1ms\n" } });
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, quiet.deps)).toBe(0);
  quiet.done();
});

test("bun and uv in one repository: one table, the 場所 column tells them apart, both sentences of conditions", async () => {
  const f = fakeUv({ bun: true });
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
  const text = f.out.join("\n");
  expect(text.match(/\| 場所 \|/g)?.length).toBe(1);
  expect(text).toContain("| root | typescript |");
  expect(text).toContain("| svc/api | pydantic |");
  expect(text).toContain("bun audit の終了コード 0");
  expect(text).toContain("bun pm ls");
  expect(text).toContain("uv tree");
  f.done();
});

test("uv: an open PR moves the package in the row's directory: the version under name = \"<pkg>\" in uv.lock, or a changed requirement in pyproject.toml", () => {
  const f = (path: string, patch: string) => ({ path, patch });
  const prs: OpenPr[] = [
    { number: 3, files: [f("uv.lock", '@@ -10,5 +10,5 @@\n [[package]]\n name = "pytest"\n-version = "9.1.1"\n+version = "9.2.0"\n source = { registry = "https://pypi.org/simple" }')] },
    { number: 4, files: [f("pyproject.toml", '@@ -1 +1 @@\n-    "pydantic>=2.0",\n+    "pydantic>=3.0",')] },
    { number: 5, files: [f("pyproject.toml", "@@ -1 +1 @@\n-    'httpx[http2]>=0.27',\n+    'httpx[http2]>=0.28',")] },
    // an environment marker with the other quote inside the requirement
    { number: 8, files: [f("pyproject.toml", `-    "rich>=13; python_version < '3.12'",\n+    "rich>=14; python_version < '3.12'",`)] },
    // an inline array: anyio's requirement changed; sniffio's and idna's did not
    { number: 7, files: [f("pyproject.toml", '-dependencies = ["anyio>=4.0", "sniffio", "idna>=3"]\n+dependencies = ["anyio>=4.5", "sniffio", "idna>=3"]')] },
    // uv.lock: another package's dependency list naming certifi does not handle certifi
    { number: 6, files: [f("uv.lock", '-    { name = "certifi" },\n+    { name = "certifi", marker = "x" },')] },
    // another directory's uv.lock does not handle the row of this directory (the vulnerability there stays)
    // a bun file does not handle a uv row of the same name
    { number: 13, files: [f("web/package.json", '+    "filelock": "^4.0.0",')] },
    { number: 9, files: [f("tests/integration/uv.lock", ' name = "filelock"\n-version = "3.12.0"\n+version = "3.20.3"')] },
  ];
  const rows = [
    dep({ tool: "uv", name: "pytest", current: "9.1.1" }),
    dep({ tool: "uv", name: "pydantic", current: "2.13.5" }),
    dep({ tool: "uv", name: "httpx", current: "0.27.2" }),
    dep({ tool: "uv", name: "anyio", current: "4.0.0" }),
    dep({ tool: "uv", name: "sniffio", current: "1.3.0" }),
    dep({ tool: "uv", name: "idna", current: "3.0" }),
    dep({ tool: "uv", name: "rich", current: "13.9.0" }),
    dep({ tool: "uv", name: "certifi", current: "2026.10.19" }),
    dep({ tool: "uv", dir: "agent", name: "filelock", current: "3.12.0" }),
    dep({ tool: "uv", dir: "tests/integration", name: "filelock", current: "3.12.0" }),
  ];
  const got = excludeFiled(rows, prs);
  expect(got.rows.map((r) => `${r.dir} ${r.name}`)).toEqual([". sniffio", ". idna", ". certifi", "agent filelock"]);
  expect(got.filed).toEqual([{ name: "pytest", prs: [3] }, { name: "pydantic", prs: [4] }, { name: "httpx", prs: [5] }, { name: "anyio", prs: [7] }, { name: "rich", prs: [8] }, { name: "filelock", prs: [9] }]);
});

test("uv: PyPI could not be read for a package, or has no date for its current version: named in one line, the check goes on", async () => {
  const f = fakeUv();
  const fetchJson = f.deps.fetchJson;
  const deps = { ...f.deps, fetchJson: async (url: string) => (url.endsWith("/certifi/json") ? null : url.endsWith("/starlette/json") ? pypi({ "1.10.0": "2026-11-02" }) : fetchJson(url)) };
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, deps)).toBe(1);
  const text = f.out.join("\n");
  expect(f.out).toContain("今の版の公開日が読めず 90 日の判定をしていない: certifi、starlette、svc/api/certifi、svc/api/starlette");
  expect(text).not.toMatch(/\| \. \| certifi/);
  expect(text).toContain("| . | pydantic | 2.13.5 | 3.0.0 | outdated（major の遅れ）");
  f.done();
});

test("uv: the license is the candidate's only when the candidate is PyPI's latest release", async () => {
  const f = fakeUv({ upgrade: { ".": "Resolved 3 packages in 1ms\nUpdate pytest v9.1.1 -> v9.2.0\n", "svc/api": "Resolved 3 packages in 1ms\nUpdate pytest v9.1.1 -> v9.2.0\n" } });
  const fetchJson = f.deps.fetchJson;
  const newer = pypi({ "9.1.1": "2026-10-25", "9.2.0": "2026-11-01", "9.3.0": "2026-11-08" }, "Apache-2.0");
  const deps = { ...f.deps, fetchJson: async (url: string) => (url.endsWith("/pytest/json") ? newer : fetchJson(url)) };
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, deps)).toBe(1);
  expect(f.out.join("\n")).toContain("| . | pytest | 9.1.1 | 9.2.0 | 脆弱性 PYSEC-2026-1（修正版 9.2.0） | 2026-11-01 | 不明 |");
  f.done();
});

test("judge: the row of a vulnerability the outdated list did not name keeps the package manager", () => {
  const rows = judge([], [{ name: "minimist", severity: "high", title: "t", id: "GHSA-x" }], NOW, {}, "bun").rows;
  expect(rows.map((r) => r.tool)).toEqual(["bun"]);
  // so a file of another package manager does not handle it
  expect(excludeFiled(rows, [{ number: 1, files: [{ path: "uv.lock", patch: '+version = "9"' }] }]).rows.length).toBe(1);
});

test("--file-request: the same title's request still waiting to be sent (no number) gets nothing, and says so", async () => {
  const f = fake({ open: [{ ref: "c_1", title: titleOf(NOW) }] });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, f.deps)).toBe(1);
  expect(f.log).toEqual([]);
  expect(f.out.at(-1)).toBe("要望: 同じ題の要望 c_1 が GitHub への送信待ち（番号なし）なので足さない");
});

test("uv: a lock that does not match pyproject.toml is a line of the output even when nothing meets a condition", async () => {
  const f = fakeUv({ pipAudit: "missing", upgrade: { ".": "Resolved 3 packages in 1ms\n", "svc/api": "Resolved 3 packages in 1ms\n" } });
  const exec = f.deps.exec;
  const deps = { ...f.deps, exec: async (cmd: string[], o?: Parameters<typeof exec>[1]) => (cmd[1] === "lock" && cmd[2] === "--check" && o?.cwd?.endsWith("svc/api") ? { out: "", code: 1 } : exec(cmd, o)) };
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, deps)).toBe(0);
  expect(f.out).toContain("svc/api: uv lock --check が exit 1（uv.lock が pyproject.toml と合っていない）");
  f.done();
});

test("nothing left to report: the part of the 既出 check that could not be done is still said in the output", async () => {
  const f = fake({ prs: [{ number: 5, files: [{ path: "package.json", patch: '+    "typescript": "^7.0.2",' }], unread: ["bun.lock"] }] });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, f.deps)).toBe(0);
  expect(f.out).toContain("既出の確認が一部できない: #5 の bun.lock（GitHub が差分を省いた）");
  expect(f.out.at(-1)).toBe("要望: 当たらないので起票しない");
  f.done();
});

test("uv: a vulnerability the outdated list did not name keeps uv as its tool and stays listed, whatever the open PRs do", () => {
  const rows = judge([], [{ name: "filelock", severity: "修正版 3.20.3", title: "t", id: "PYSEC-1", dir: "agent" }], NOW, {}, "uv").rows;
  expect(rows.map((r) => `${r.dir} ${r.name} ${r.tool}`)).toEqual(["agent filelock uv"]);
  const bunPr = { number: 1, files: [{ path: "web/package.json", patch: '+    "filelock": "^4.0.0",' }] };
  const uvPr = { number: 2, files: [{ path: "agent/uv.lock", patch: ' name = "filelock"\n-version = "3.12.0"\n+version = "3.20.3"' }] };
  expect(excludeFiled(rows, [bunPr]).rows.length).toBe(1);
  expect(excludeFiled(rows, [uvPr]).rows.length).toBe(1);
});

test("uv: pyproject names compare as PEP 503 normalises them (PyYAML = pyyaml, typing_extensions = typing-extensions)", () => {
  const pr = { number: 3, files: [{ path: "pyproject.toml", patch: '-    "PyYAML>=6.0",\n+    "PyYAML>=6.1",\n-    "typing_extensions>=4.12",\n+    "typing_extensions>=4.13",' }] };
  const rows = [dep({ tool: "uv", name: "pyyaml", current: "6.0.1" }), dep({ tool: "uv", name: "typing-extensions", current: "4.12.2" })];
  expect(excludeFiled(rows, [pr]).filed).toEqual([{ name: "pyyaml", prs: [3] }, { name: "typing-extensions", prs: [3] }]);
});

test("uv: versions compare by PEP 440 (rc1 is later than rc1.dev2), so an older prerelease does not handle the row", () => {
  const row = dep({ tool: "uv", name: "httpx", current: "1.0rc1" });
  const pr = (v: string) => ({ number: 1, files: [{ path: "uv.lock", patch: ` name = "httpx"\n-version = "1.0rc1"\n+version = "${v}"` }] });
  expect(excludeFiled([row], [pr("1.0rc1.dev2")]).rows.length).toBe(1);
  expect(excludeFiled([row], [pr("1.0")]).filed).toEqual([{ name: "httpx", prs: [1] }]);
});

test("uv: pip-audit did not run in some places: the summary line says which were not checked", async () => {
  const f = fakeUv({ pipAudit: "garbled", upgrade: { ".": "Resolved 3 packages in 1ms\n", "svc/api": "Resolved 3 packages in 1ms\n" } });
  expect(await depsCheck({ fileRequest: true, extraConditions: [] }, f.deps)).toBe(0);
  expect(f.out.find((l) => l.startsWith("deps-check:"))).toBe("deps-check: 当たらない（outdated 0 件、脆弱性 0 件（.、svc/api は未検査）、条件に当たる 0 件、既出 0 件）");
  f.done();
});

test("uv: directDeps reads the names of dependencies, optional-dependencies and dependency-groups (PEP 503); not TOML is null", () => {
  const toml = '[project]\nname = "x"\ndependencies = ["PyYAML>=6", "typing_extensions; python_version < \'3.12\'", "foo[bar] @ https://x/y.whl"]\n[project.optional-dependencies]\nweb = ["Starlette.Extra>=1"]\n[dependency-groups]\ndev = ["pytest", {include-group = "web"}]\n';
  expect([...directDeps(toml)!].sort()).toEqual(["foo", "pytest", "pyyaml", "starlette-extra", "typing-extensions"]);
  expect(directDeps("[project]\nname = 'x'\n")!.size).toBe(0);
  expect(directDeps("= not toml [")).toBeNull();
});

test("uv: only the direct dependencies stay in the table; a transitive one stays when pip-audit names it; the count is after the narrowing", async () => {
  // starlette and pydantic are transitive here; pytest (vulnerable in `.`) is transitive too, certifi is direct
  const f = fakeUv({ pyproject: '[project]\nname = "x"\ndependencies = ["CertiFi"]\n' });
  expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
  const text = f.out.join("\n");
  expect(text).toContain("| . | pytest | 9.1.1 | 9.2.0 | 脆弱性 PYSEC-2026-1");
  expect(text).not.toMatch(/\| (\.|svc\/api) \| (pydantic|starlette) /);
  expect(text).not.toContain("pyproject.toml が読めない");
  expect(text).toMatch(/outdated 3 件、脆弱性 1 件/); // `.`: certifi + pytest, svc/api: certifi
  f.done();
});

test("uv: a pyproject.toml that cannot be read narrows nothing and is named in one line", async () => {
  for (const pyproject of [null, "= not toml ["]) {
    const f = fakeUv({ pyproject });
    expect(await depsCheck({ fileRequest: false, extraConditions: [] }, f.deps)).toBe(1);
    expect(f.out.filter((s) => s.includes("pyproject.toml が読めない")).length).toBe(2); // one per directory
    expect(f.out.join("\n")).toContain("| svc/api | pydantic |"); // unnarrowed: the table is the one of the full list
    expect(f.out.join("\n")).toMatch(/outdated 8 件/);
    f.done();
  }
});
