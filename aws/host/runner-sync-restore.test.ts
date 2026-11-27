// test-reads: aws/host/
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * runner-sync restore after the daily archive has moved records to history/runner: the real archive.sh writes the
 * list, the real runner-sync.sh saves and restores, and only `aws` (a folder as the bucket), `bun` and `age` are fakes.
 */
const HERE = import.meta.dir;
let dir: string, bin: string, s3: string;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const rel = (id: string) => `.claude/projects/-w/${id}.jsonl`;

function fake(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}
function sh(script: string, args: string[], home: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", join(HERE, script), ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, SB_HOST_ENV: join(dir, "host.env"), HOME: home, S3OUT: s3, SB_PRE_REBUILD: "/bin/true", SB_RUNNER_KEEP_MB: "1", ...env },
    stderr: "pipe", stdout: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-test-restore-"));
  bin = join(dir, "bin");
  s3 = join(dir, "s3");
  mkdirSync(bin);
  mkdirSync(s3);
  writeFileSync(join(dir, "host.env"), "SB_DATA_BUCKET=bucket\nSB_REPO_DIR=/nowhere\n");
  // the bucket is a folder: cp and put-object copy a file to <key>, list-objects-v2 prints the keys under archive/runner/
  fake("aws", `case "$1 $2" in
  "ssm get-parameter") echo age1recipient;;
  "s3 cp") case "$3" in s3://bucket/*) cp "$S3OUT/\${3#s3://bucket/}" "$4";; *) k="\${4#s3://bucket/}"; mkdir -p "$(dirname "$S3OUT/$k")"; cp "$3" "$S3OUT/$k";; esac;;
  "s3api put-object") while [ $# -gt 0 ]; do case "$1" in --key) k="$2";; --body) b="$2";; esac; shift; done; mkdir -p "$(dirname "$S3OUT/$k")"; cp "$b" "$S3OUT/$k";;
  "s3api list-objects-v2") (cd "$S3OUT" && find archive/runner -type f | sort | paste -sd'\\t' -) | grep . || echo None;;
esac
exit 0`);
  fake("bun", `[ "$1" = -e ] && exit 0; [ "$2" = export ] && echo pkg > "$3"; exit 0`);
  fake("age", "cat");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("restore leaves out what the daily archive moved, brings back what was appended to after, and a row from before mtime and size", () => {
  const home = join(dir, "home");
  mkdirSync(join(home, ".claude", "projects", "-w"), { recursive: true });
  mkdirSync(join(home, ".switchboard"), { recursive: true });
  writeFileSync(join(home, ".switchboard", "switchboard.db"), ""); // the archive moves nothing without the database
  // the files the archive adds exist before the base, or the second run would find new folders and take a new base
  writeFileSync(join(home, ".switchboard", "runner-archive.tsv"), "");
  writeFileSync(join(home, ".switchboard", "disk-history.tsv"), "2026-01-01\t1\n");
  const old = new Date(Date.now() - 30 * 86400_000);
  old.setMilliseconds(0);
  for (const [id, text] of [[A, "a-old\n"], [B, "b-old\n"], [C, "c-old\n"]] as const) {
    writeFileSync(join(home, rel(id)), text);
    utimesSync(join(home, rel(id)), old, old);
  }
  // the base holds all three; then the daily archive moves them (30 days old) and lists them with mtime and size
  expect(sh("runner-sync.sh", [], home).code).toBe(0);
  const archived = sh("archive.sh", [], home);
  expect(archived.code).toBe(0);
  const listFile = join(home, ".switchboard", "runner-archive.tsv");
  const rows = readFileSync(listFile, "utf8").trim().split("\n").map((l) => l.split("\t"));
  expect(rows.length).toBe(3);
  for (const r of rows) expect(r.slice(4)).toEqual([String(Math.floor(old.getTime() / 1000)), String(Buffer.byteLength(r[0]!.includes(A) ? "a-old\n" : r[0]!.includes(B) ? "b-old\n" : "c-old\n"))]);
  for (const id of [A, B, C]) expect(existsSync(join(home, rel(id)))).toBe(false);
  // b is appended to after it was moved (a resumed session): it is on the disk again, bigger and newer
  Bun.sleepSync(20);
  writeFileSync(join(home, rel(B)), "b-old\nb-appended\n");
  // c's row is one from before the archive listed mtime and size
  writeFileSync(listFile, readFileSync(listFile, "utf8").split("\n").map((l) => (l.includes(C) ? l.split("\t").slice(0, 4).join("\t") : l)).join("\n"));
  expect(sh("runner-sync.sh", [], home).code).toBe(0); // a difference: b, the list
  const restored = join(dir, "restored");
  mkdirSync(restored);
  const r = sh("runner-sync.sh", ["restore"], restored);
  expect(r.code).toBe(0);
  expect(r.out).toContain("left out 2 records already in history/runner"); // a and b as the base holds them
  expect(existsSync(join(restored, rel(A)))).toBe(false); // (1)
  expect(readFileSync(join(restored, rel(B)), "utf8")).toBe("b-old\nb-appended\n"); // (2)
  expect(readFileSync(join(restored, rel(C)), "utf8")).toBe("c-old\n"); // (3)
  // (4) a stays in the list, and the key it names holds it
  const rowA = readFileSync(join(restored, ".switchboard", "runner-archive.tsv"), "utf8").split("\n").map((l) => l.split("\t")).find((c) => c[0] === rel(A))!;
  expect(rowA[2]).toMatch(/^history\/runner\/runner-/);
  const held = Bun.spawnSync(["tar", "--zstd", "-tf", join(s3, rowA[2]!)]).stdout.toString().split("\n");
  expect(held).toContain(rel(A));
}, 30000);

test("a list that cannot be read leaves nothing out", () => {
  const home = join(dir, "home-nolist");
  mkdirSync(join(home, ".claude", "projects", "-w"), { recursive: true });
  writeFileSync(join(home, rel(A)), "a\n");
  rmSync(s3, { recursive: true, force: true });
  mkdirSync(s3);
  expect(sh("runner-sync.sh", [], home).code).toBe(0);
  const restored = join(dir, "restored-nolist");
  mkdirSync(restored);
  const r = sh("runner-sync.sh", ["restore"], restored);
  expect(r.code).toBe(0);
  expect(r.out).toContain("left out 0 records");
  expect(readFileSync(join(restored, rel(A)), "utf8")).toBe("a\n");
});

test("restore leaves out the older copies of a moved record too, from an earlier difference or the base", () => {
  rmSync(s3, { recursive: true, force: true });
  mkdirSync(s3);
  const home = join(dir, "home-older");
  mkdirSync(join(home, ".claude", "projects", "-w"), { recursive: true });
  mkdirSync(join(home, ".switchboard"), { recursive: true });
  writeFileSync(join(home, ".switchboard", "switchboard.db"), "");
  writeFileSync(join(home, ".switchboard", "runner-archive.tsv"), "");
  writeFileSync(join(home, ".switchboard", "disk-history.tsv"), "2026-01-01\t1\n");
  const at = (daysAgo: number) => new Date(Math.floor(Date.now() / 1000 - daysAgo * 86400) * 1000);
  for (const id of [A, B]) {
    writeFileSync(join(home, rel(id)), "v1\n");
    utimesSync(join(home, rel(id)), at(40), at(40));
  }
  expect(sh("runner-sync.sh", [], home).code).toBe(0); // base: a and b at v1
  writeFileSync(join(home, rel(A)), "v1\nv2\n");
  utimesSync(join(home, rel(A)), at(30), at(30));
  expect(sh("runner-sync.sh", [], home).code).toBe(0); // difference: a at v2
  writeFileSync(join(home, rel(B)), "v1\nv2\n"); // b grows and is moved before a sync saves it
  utimesSync(join(home, rel(B)), at(30), at(30));
  expect(sh("archive.sh", [], home).code).toBe(0); // moves a and b at v2
  for (const id of [A, B]) expect(existsSync(join(home, rel(id)))).toBe(false);
  expect(sh("runner-sync.sh", [], home).code).toBe(0); // difference: the list
  const restored = join(dir, "restored-older");
  mkdirSync(restored);
  const r = sh("runner-sync.sh", ["restore"], restored);
  expect(r.code).toBe(0);
  expect(r.out).toContain("left out 2 records already in history/runner");
  expect(existsSync(join(restored, rel(A)))).toBe(false); // not v1 from the base in place of v2
  expect(existsSync(join(restored, rel(B)))).toBe(false);
}, 30000);
