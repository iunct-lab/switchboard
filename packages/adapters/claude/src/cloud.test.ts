import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent } from "@switchboard/protocol";
import { createClaudeAdapter } from "./index.ts";
import { CloudSession, cloudChildEnv, parseCloudSessionRef, buildCloudArgs, cloudFailure, claudeFolderTrust, cloudTrustGuidance } from "./cloud.ts";
const dirs: string[] = [];
// An empty config dir keeps the developer's own ~/.claude.json out of these tests (folder trust reads it): "unknown", so Cloud starts.
beforeAll(() => { const d = mkdtempSync(join(tmpdir(), "sb-cloud-cfg-")); dirs.push(d); process.env.CLAUDE_CONFIG_DIR = d; });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const id = "session_0123456789abcdefghijklmn";
const output = recordingText("packages/adapters/claude/fixtures/cloud-start.txt");
function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-cloud-cli-")); dirs.push(dir);
  const bin = join(dir, "claude"); writeFileSync(bin, `#!${process.execPath}\n${body}\n`); chmodSync(bin, 0o755); return { bin, dir };
}

test.skipIf(skipRecordings("packages/adapters/claude/fixtures/cloud-start.txt"))("new creation parser: canonical reference, ANSI, mismatch, foreign host, follow-up JSON", () => {
    assertRecordings("packages/adapters/claude/fixtures/cloud-start.txt");
  expect(parseCloudSessionRef(`\x1b[32m${output}\x1b[0m`)).toEqual({ id, url: `https://claude.ai/code/${id}` });
  for (const text of [output.replace('Created cloud session:', 'Sent to cloud session.'), output.replace('claude.ai', 'claude.ai.evil.test'), output.replace(`--teleport ${id}`, '--teleport session_other'), JSON.stringify({ ok: true, session_id: id, url: `https://claude.ai/code/${id}` })]) expect(parseCloudSessionRef(text)).toBeNull();
});

test.skipIf(skipRecordings("packages/adapters/claude/fixtures/cloud-start.txt"))("Cloud uses TTY and only user prompt/cwd; no inherited force Bundle or local args", async () => {
    assertRecordings("packages/adapters/claude/fixtures/cloud-start.txt");
  const { bin, dir } = fixture(`import {writeFileSync} from 'node:fs'; writeFileSync('capture.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),force:process.env.CCR_FORCE_BUNDLE,tty:[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY]})); for(const c of ${JSON.stringify(output)}) {process.stdout.write(c); await Bun.sleep(1);}`);
  const old = process.env.CCR_FORCE_BUNDLE; process.env.CCR_FORCE_BUNDLE = "1";
  const events: AgentEvent[] = [];
  try {
    const session = createClaudeAdapter({ bin, extraArgs: ["--local-only"] }).start({ cwd: dir, scope: [dir], prompt: "only user", preamble: "LOCAL SECRET", executionMode: "cloud" }, (e) => events.push(e));
    expect(await session.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"))).toEqual({ args: ["--cloud", "only user"], cwd: dir, tty: [true,true,true] });
    expect(events.filter(e => e.t === "cloud.session.created")).toHaveLength(1);
    expect(events.some(e => e.t === "session.end")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("LOCAL SECRET");
    expect(() => session.send("followup")).toThrow("公式 Web");
  } finally { if (old === undefined) delete process.env.CCR_FORCE_BUNDLE; else process.env.CCR_FORCE_BUNDLE = old; }
});

test("unconfirmed exit and errors are safe; startup timeout kills without responding to setup", async () => {
  for (const text of ["", "permission denied on private repository", "API code: fixture-secret", "Bedrock unsupported", "allow_remote_sessions policy disabled"]) {
    const { bin, dir } = fixture(`process.stderr.write(${JSON.stringify(text)});`); const events: AgentEvent[]=[];
    const s = createClaudeAdapter({ bin }).start({ cwd:dir,scope:[dir],prompt:"explain",executionMode:"cloud" }, e=>events.push(e)); await s.exited;
    expect(events.some(e=>e.t==='cloud.session.created')).toBe(false); expect(events.some(e=>e.t==='error')).toBe(true);
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
  }
  expect(cloudFailure("API keys are not supported for cloud")).toContain("サブスクリプション");
  expect(cloudFailure("unknown argument --cloud")).toContain("更新");
  const {bin,dir}=fixture(`process.stdout.write('Choose the text style'); await Bun.sleep(10000);`); const events: AgentEvent[]=[];
  const s = new CloudSession(bin, {cwd:dir,scope:[dir],prompt:"p"}, e=>events.push(e), { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR! }, 50);
  await s.exited; expect(events.some(e=>e.t==='error')).toBe(true);
  expect(cloudChildEnv({ CCR_FORCE_BUNDLE:'1', DEVICE_AUTH_URL:'secret', DEVICE_AUTH_TOKEN_FILE:'private-path', OTHER:'keep' })).toEqual({OTHER:'keep'});
});


test("Cloud cannot attach to an existing session or apply unsupported Local options", () => {
  const opts = { cwd: "/tmp", scope: ["/tmp"], prompt: "explain" };
  for (const prompt of [id, `https://claude.ai/code/${id}`, `claude.ai/code/${id}`]) expect(() => buildCloudArgs({ ...opts, prompt })).toThrow("新規作成");
  for (const prompt of ["  ", "--teleport", " -p"]) expect(() => buildCloudArgs({ ...opts, prompt })).toThrow("作業指示文");
  for (const extra of [{ model: "opus" }, { permissionMode: "auto" }, { resumeSessionId: "local" }, { scope: ["/tmp", "/elsewhere"] }]) expect(() => buildCloudArgs({ ...opts, ...extra })).toThrow();
});

const trustPrompt = recordingText("packages/adapters/claude/fixtures/cloud-trust-prompt.txt");
function trustFixture(config: string | null, body: string) {
  const f = fixture(`import {writeFileSync,appendFileSync} from 'node:fs'; appendFileSync('started', '1'); let stdin=''; process.stdin.setRawMode(true); process.stdin.on('data',d=>{stdin+=d; writeFileSync('stdin.txt', stdin)}); ${body}`);
  const cfg = join(f.dir, "cfg"); mkdirSync(cfg);
  if (config !== null) writeFileSync(join(cfg, ".claude.json"), config);
  return { ...f, cfg, env: { CLAUDE_CONFIG_DIR: cfg } };
}
const configFile = (f: { cfg: string }) => { try { return readFileSync(join(f.cfg, ".claude.json"), "utf8"); } catch { return null; } };
const started = (f: { dir: string }) => existsSync(join(f.dir, "started"));
const stdinOf = (f: { dir: string }) => existsSync(join(f.dir, "stdin.txt")) ? readFileSync(join(f.dir, "stdin.txt"), "utf8") : "";

test("trust (a): untrusted folder is not started and start throws the guidance", () => {
  const f = trustFixture("{}", "");
  const config = JSON.stringify({ projects: { "/somewhere/else": { hasTrustDialogAccepted: true } } });
  writeFileSync(join(f.cfg, ".claude.json"), config);
  expect(claudeFolderTrust(f.dir, f.env)).toBe("untrusted");
  const events: AgentEvent[] = [];
  expect(() => new CloudSession(f.bin, { cwd: f.dir, scope: [f.dir], prompt: "p" }, (e) => events.push(e), f.env)).toThrow("信頼されていない");
  expect(() => new CloudSession(f.bin, { cwd: f.dir, scope: [f.dir], prompt: "p" }, () => {}, f.env)).toThrow(`cd ${f.dir}`);
  expect(started(f)).toBe(false);
  expect(configFile(f)).toBe(config);
});

test.skipIf(skipRecordings("packages/adapters/claude/fixtures/cloud-start.txt"))("trust (b): trusted folder (record on it) creates the session; stdin is only terminal replies", async () => {
    assertRecordings("packages/adapters/claude/fixtures/cloud-start.txt");
  const f = trustFixture(null, `process.stdout.write('\\x1b[6n'); for(const c of ${JSON.stringify(output)}) {process.stdout.write(c); await Bun.sleep(1);} await Bun.sleep(300); process.exit(0);`);
  const sub = join(f.dir, "sub"); mkdirSync(sub);
  const config = JSON.stringify({ projects: { [realpathSync(f.dir)]: { hasTrustDialogAccepted: true } } });
  writeFileSync(join(f.cfg, ".claude.json"), config);
  expect(claudeFolderTrust(f.dir, f.env)).toBe("trusted");
  expect(claudeFolderTrust(sub, f.env)).toBe("unknown");  // an ancestor's record alone is not verified to cover a subfolder
  const events: AgentEvent[] = [];
  const s = new CloudSession(f.bin, { cwd: f.dir, scope: [f.dir], prompt: "p" }, (e) => events.push(e), f.env);
  expect(await s.exited).toBe(0);
  expect(events.filter((e) => e.t === "cloud.session.created")).toHaveLength(1);
  expect(configFile(f)).toBe(config);
  expect(stdinOf(f)).toBe("\x1b[1;1R");
});

test.skipIf(skipRecordings("packages/adapters/claude/fixtures/cloud-trust-prompt.txt"))("trust (c): unknown config starts as before and stops at the trust dialog with the guidance", async () => {
    assertRecordings("packages/adapters/claude/fixtures/cloud-trust-prompt.txt");
  for (const config of [null, "{ not json", JSON.stringify({ theme: "dark" })]) {
    const f = trustFixture(config, `process.stdout.write('\\x1b[6n'); await Bun.sleep(300); process.stdout.write(${JSON.stringify(trustPrompt)}); await Bun.sleep(20000);`);
    expect(claudeFolderTrust(f.dir, f.env)).toBe("unknown");
    const events: AgentEvent[] = [];
    const t0 = Date.now();
    const s = new CloudSession(f.bin, { cwd: f.dir, scope: [f.dir], prompt: "p" }, (e) => events.push(e), f.env, 30_000);
    await s.exited;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(started(f)).toBe(true);
    const err = events.find((e) => e.t === "error");
    expect(err && err.t === "error" ? err.message : "").toBe(cloudTrustGuidance(f.dir));
    expect(configFile(f)).toBe(config);
    expect(stdinOf(f)).toBe("\x1b[1;1R");
  }
});

test.skipIf(skipRecordings("packages/adapters/claude/fixtures/cloud-trust-prompt.txt"))("trust (d): the recorded dialog is recognised and no setup answer is written", () => {
    assertRecordings("packages/adapters/claude/fixtures/cloud-trust-prompt.txt");
  expect(parseCloudSessionRef(trustPrompt)).toBeNull();
  expect(cloudFailure(trustPrompt)).toContain("確認できません");
});

test("trust guidance quotes a folder name the shell would split", () => {
  expect(cloudTrustGuidance("/work/app")).toContain("`cd /work/app`");
  expect(cloudTrustGuidance("/work/my repo's")).toContain("`cd '/work/my repo'\\''s'`");
});
