import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CloudSessionRef, type AgentEvent, type RunnerSession, type StartOptions } from "@switchboard/protocol";

export function buildCloudArgs(opts: StartOptions): string[] {
  if (opts.model || opts.permissionMode || opts.resumeSessionId || opts.attachments?.length || opts.scope.some((p) => p !== opts.cwd)) throw new Error("Cloud はモデル・権限・Local再開・添付・追加scopeを指定できません。公式 Web で操作してください。");
  if (/^(?:session_|cse_)[A-Za-z0-9_-]+$/.test(opts.prompt) || /^(?:https:\/\/)?claude\.ai\/code\//.test(opts.prompt)) throw new Error("Cloud 新規作成にはセッションIDではなく作業指示文を入力してください。");
  if (!opts.prompt.trim() || opts.prompt.trimStart().startsWith("-")) throw new Error("Cloud 新規作成にはCLIオプションではなく作業指示文を入力してください。");
  return ["--cloud", opts.prompt];
}

export function cloudChildEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== "CCR_FORCE_BUNDLE" && !k.startsWith("DEVICE_AUTH_") && !k.startsWith("SWITCHBOARD_MCP_")) env[k] = v;
  return env;
}

export function stripCloudAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Za-z0-9]|\x1b[78=>]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Only the observed new-creation text, never follow-up JSON or arbitrary links. */
export function parseCloudSessionRef(output: string) {
  const s = stripCloudAnsi(output);
  if (!s.includes("Created cloud session:")) return null;
  const view = /View:\s*(https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]+)(?:\?[^\s]*)?)(?=\s|$)/.exec(s);
  if (!view) return null;
  const id = view[2]!;
  if (!new RegExp(`Resume with:\\s*claude --teleport ${id}(?=\\s|$)`).test(s)) return null;
  const ref = { id, url: `https://claude.ai/code/${id}` };
  return CloudSessionRef.safeParse(ref).success ? ref : null;
}

export function cloudFailure(output: string): string {
  const s = stripCloudAnsi(output);
  if (/unknown (?:option|argument)|unrecognized.*cloud|requires an interactive terminal/i.test(s)) return "Cloud 対応 CLI と Bun の PTY が必要です。Claude Code と Bun を更新してください。";
  if (/Bedrock|Vertex|Foundry|third.party provider/i.test(s)) return "Cloud は外部 provider では利用できません。claude.ai サブスクリプション認証を確認してください。";
  if (/allow_remote_sessions|organization.*disabled|policy.*disabled/i.test(s)) return "組織ポリシーで Cloud が無効です。管理者へ Cloud 許可を確認してください。";
  if (/api.?keys?.*(?:not supported|not available)|requires?.*subscription/i.test(s)) return "Cloud には claude.ai サブスクリプション認証が必要です。APIキーだけでは利用できません。利用者自身で claude auth login を実行してください。";
  if (/not logged in|invalid api key|unauthorized|oauth.*expired|please.*login/i.test(s)) return "Cloud の認証を確認してください。利用者自身で claude auth login を実行してください。";
  if (/repository not found|permission denied|github.*access|403/i.test(s)) return "Private リポジトリへのアクセス権を確認してください。GitHub App または利用者自身の /web-setup が必要です。";
  return "Cloud 作成を確認できません。端末で Claude Code の初回設定・認証・リポジトリ確認を完了し、公式 Web でセッションの有無を確認してください。自動再試行はしません。";
}

/**
 * Claude Code's folder-trust dialog ("Quick safety check … Yes, I trust this folder"); recorded outside Git as packages/adapters/claude/fixtures/cloud-trust-prompt.txt (record your own outside Git with the runner-adapter-recording skill;
 * bun scripts/fixtures.ts fetch works only in a clone with the private history). Cursor moves leave no spaces once stripped.
 */
const TRUST_PROMPT = /Quick\s*safety\s*check|Yes,\s*I\s*trust\s*this\s*folder/i;

/**
 * Whether Claude Code already trusts `cwd`, read from its config (`<CLAUDE_CONFIG_DIR>/.claude.json`, else ~/.claude.json):
 * `projects["<absolute path>"].hasTrustDialogAccepted`. Only a record on `cwd` itself counts as trusted. Whether a parent's
 * approval covers a subfolder is not verified against the CLI, so an ancestor-only record is "unknown" (Cloud starts and
 * the dialog guard below answers); "untrusted" means neither `cwd` nor any ancestor has a record. Read-only; an
 * unreadable or differently shaped file is "unknown" too.
 */
export function claudeFolderTrust(cwd: string, env: Record<string, string | undefined> = process.env): "trusted" | "untrusted" | "unknown" {
  try {
    const file = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
    const projects = (JSON.parse(readFileSync(file, "utf8")) as { projects?: unknown } | null)?.projects;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return "unknown";
    const records = projects as Record<string, { hasTrustDialogAccepted?: unknown } | null>;
    const start = realpathSync(cwd);
    if (records[start]?.hasTrustDialogAccepted === true) return "trusted";
    for (let dir = dirname(start); ; dir = dirname(dir)) {
      if (records[dir]?.hasTrustDialogAccepted === true) return "unknown";
      if (dirname(dir) === dir) return "untrusted";
    }
  } catch {
    return "unknown";
  }
}

export function cloudTrustGuidance(cwd: string): string {
  const dir = /^[\w@%+=:,./-]+$/.test(cwd) ? cwd : `'${cwd.replaceAll("'", "'\\''")}'`;
  return `このフォルダ（${cwd}）は Claude Code でまだ信頼されていないため、Cloud の作成が信頼の確認で止まります。Switchboard はこの確認に答えません。ご自分の端末で \`cd ${dir}\` → \`claude\` を実行し、信頼の確認で「Yes, I trust this folder」を選んで終了してから、もう一度 Cloud で作成してください。`;
}

export class CloudSession implements RunnerSession {
  readonly exited: Promise<number | null>;
  private proc: ReturnType<typeof Bun.spawn>;
  private buffer = "";
  private created = false;
  private closing = false;
  private trustPrompt = false;
  private timer: ReturnType<typeof setTimeout>;
  constructor(bin: string, opts: StartOptions, emit: (ev: AgentEvent) => void, env: Record<string, string>, timeoutMs = 60_000) {
    if (typeof Bun.Terminal !== "function") throw new Error("Cloud には Bun 内蔵 PTY が必要です。Bun を更新してください。");
    const decoder = new TextDecoder();
    const args = buildCloudArgs(opts);
    if (claudeFolderTrust(opts.cwd, env) === "untrusted") throw new Error(cloudTrustGuidance(opts.cwd));
    this.proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd, env: { ...cloudChildEnv(env), TERM: "xterm-256color" },
      terminal: { cols: 160, rows: 40, data: (term, bytes) => {
        this.buffer = (this.buffer + decoder.decode(bytes, { stream: true })).slice(-65536);
        // Terminal capability queries only. Never answer setup/trust/authentication prompts.
        if (this.buffer.includes("\x1b[6n")) { term.write("\x1b[1;1R"); this.buffer = this.buffer.replaceAll("\x1b[6n", ""); }
        if (this.buffer.includes("\x1b]11;?")) { term.write("\x1b]11;rgb:0000/0000/0000\x1b\\"); this.buffer = this.buffer.replaceAll("\x1b]11;?", ""); }
        if (!this.created) {
          const ref = parseCloudSessionRef(this.buffer);
          if (ref) { this.created = true; emit({ t: "cloud.session.created", ...ref }); }
          else if (!this.trustPrompt && TRUST_PROMPT.test(stripCloudAnsi(this.buffer))) { this.trustPrompt = true; clearTimeout(this.timer); this.proc.kill("SIGTERM"); this.timer = setTimeout(() => this.proc.kill("SIGKILL"), 1500); }
        }
      } },
    });
    this.timer = setTimeout(() => { this.proc.kill("SIGTERM"); this.timer = setTimeout(() => this.proc.kill("SIGKILL"), 1500); }, timeoutMs);
    this.exited = this.proc.exited.then(async (code) => {
      clearTimeout(this.timer);
      // PTY EOF can follow subprocess exit; allow the last creation bytes to arrive.
      await Bun.sleep(50);
      this.proc.terminal?.close();
      if (!this.created && !this.closing) emit({ t: "error", message: this.trustPrompt ? cloudTrustGuidance(opts.cwd) : cloudFailure(this.buffer) });
      return code;
    });
    emit({ t: "message.delta", role: "user", text: opts.prompt });
    emit({ t: "status", text: "公式 Cloud の開始を確認中です。Cloud 側の作業状態は未確認です。" });
  }
  send(): never { throw new Error("Cloud の続行は公式 Web で操作してください。"); }
  respondPermission(): never { throw new Error("Cloud の承認は公式 Web で操作してください。"); }
  setPermissionMode(): never { throw new Error("Cloud の権限は公式 Web で操作してください。"); }
  async abort() { await this.close(); }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const kill = setTimeout(() => this.proc.kill("SIGKILL"), 1500);
      await this.exited; clearTimeout(kill);
    }
    await this.exited;
    this.proc.terminal?.close();
  }
}
