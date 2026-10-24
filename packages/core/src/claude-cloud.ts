import { claudeFolderTrust, cloudTrustGuidance } from "@switchboard/adapter-claude";
import type { CloudPreparation } from "@switchboard/protocol";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { teleportWorktreePath } from "./config.ts";

export const cloudTransferNotice = "Cloud を選んで開始すると、公式 CLI の自動 Bundle 転送を了承します。GitHub clone では未pushコミット・未コミット変更が反映されない場合があります。自動 Bundle では全ブランチの履歴・追跡ファイルの変更が送られ得ます。未追跡ファイルは含まれず、秘密情報が必ず除外される保証はありません。Switchboard は commit/push や強制 Bundle を行いません。";

/** Read-only local Git observations. Never fetch: remote refs may be stale. */
export function readCloudPreparation(cwd: string): CloudPreparation {
  const warnings = [cloudTransferNotice];
  // Known-untrusted only: trusted and unknown add nothing (unknown starts as before; the adapter stops at the dialog).
  if (claudeFolderTrust(cwd) === "untrusted") warnings.push(cloudTrustGuidance(cwd));
  const git = (...args: string[]) => {
    try {
      const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", timeout: 3000, maxBuffer: 8192, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      return p.exitCode === 0 ? p.stdout.toString().trim() : null;
    } catch { return null; }
  };
  if (git("rev-parse", "--is-inside-work-tree") !== "true") return { repository: null, branch: null, dirty: null, unpushed: null, warnings: [...warnings, "Git リポジトリを確認できません。Workspace を確認してください。"] };
  const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
  const status = git("status", "--porcelain");
  const remote = git("remote", "get-url", "origin");
  let repository: string | null = null;
  // Accept only github.com, stripping credentials, ports, query/fragment and the .git suffix.
  if (remote) {
    const ssh = /^git@github\.com:([^\s?#]+)$/.exec(remote);
    let path = ssh?.[1];
    if (!path) {
      try { const u = new URL(remote); if (u.hostname === "github.com" && ["https:", "ssh:"].includes(u.protocol)) path = u.pathname.replace(/^\//, ""); } catch {}
    }
    const clean = path?.replace(/\.git$/, "");
    if (clean && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean)) repository = clean;
  }
  if (!repository) warnings.push("origin の GitHub リポジトリは判定できません。公式 CLI がローカル Bundle を使う場合があります。");
  if (!branch) warnings.push("detached HEAD です。開始対象のブランチを確認してください。");
  const head = git("rev-parse", "--verify", "HEAD");
  if (head === null) warnings.push("まだコミットがありません。公式 Cloud の開始には Git コミットが必要です。");
  const upstream = head === null ? null : git("rev-parse", "--verify", "@{upstream}");
  const count = upstream === null ? null : git("rev-list", "--count", "@{upstream}..HEAD");
  const unpushed = count !== null && /^\d+$/.test(count) ? Number(count) > 0 : null;
  if (unpushed === null) warnings.push("未push判定は不明です（upstream 未設定など）。");
  else warnings.push("未push判定はローカルの remote ref に基づきます。最新の GitHub 状態は取得していません。");
  if (status === null) warnings.push("作業ツリーの変更は判定できません。");
  return { repository, branch, dirty: status === null ? null : status !== "", unpushed, warnings };
}

export interface TeleportResult { localSessionId: string | null; message: string }

/**
 * Output with terminal controls removed. The real CLI draws the gap between words as a cursor move (CSI n C / CSI n G),
 * not a space; `gaps` reads those as spaces — only for the resumed marker, so a move inside an ID never splits it.
 */
function terminalText(s: string, gaps = false): string {
  const t = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  return (gaps ? t.replace(/\x1b\[[0-9;]*[CG]/g, " ") : t).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Bounded public CLI evidence; no transcript or session association is persisted here. */
export class TeleportOutput {
  private tail = "";
  private targets = new Set<string>();
  private locals = new Set<string>();
  private resumed = false;
  private named = false;
  constructor(private cloudId: string) {}
  feed(chunk: string): void {
    this.tail = (this.tail + chunk).slice(-65536);
    const complete = (gaps: boolean) => terminalText(this.tail, gaps).split("\n").slice(0, -1).join("\n");
    this.capture(complete(false), complete(true));
  }
  private capture(text: string, spaced: string): void {
    for (const m of text.matchAll(/(?:session_|cse_)[A-Za-z0-9_-]+/g)) { if (this.targets.size < 2) this.targets.add(m[0]); }
    this.resumed ||= /Session\s+resumed/.test(spaced);
    this.named ||= /Session\s+renamed\s+to/.test(spaced);
    for (const m of text.matchAll(/claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/gi)) { if (this.locals.size < 2) this.locals.add(m[1]!.toLowerCase()); }
  }
  /** The CLI resumed the target Cloud session and nothing else: the only point where Switchboard may end it. */
  get ready(): boolean {
    // `resumed` is only set from complete lines; the CLI may print the marker and then wait, with no newline after it.
    const resumed = this.resumed || /Session\s+resumed/.test(terminalText(this.tail, true));
    return resumed && this.targets.size === 1 && this.targets.has(this.cloudId);
  }
  /** The CLI confirmed `/rename`: this session has recorded an entry, so its normal log exists (#1865). */
  get renamed(): boolean {
    return this.named || /Session\s+renamed\s+to/.test(terminalText(this.tail, true));
  }
  /** The last lines the CLI printed (what it is asking), for showing the user. */
  question(): string {
    const lines = terminalText(this.tail).split("\n").map(l => l.trim()).filter(Boolean);
    return lines.slice(-5).join("\n").slice(-500);
  }
  finish(code: number | null): TeleportResult {
    this.capture(terminalText(this.tail), terminalText(this.tail, true));
    const ok = code === 0 && this.resumed && this.targets.size === 1 && this.targets.has(this.cloudId) && this.locals.size === 1;
    return { localSessionId: ok ? [...this.locals][0]! : null, message: ok ? "公式Teleportが終了しました。" : teleportFailure(code === 0 ? "" : this.tail) };
  }
}

/** Public help establishes whether the official picker or targeted invocation is supported. */
export function teleportArgs(help: string, cloudId: string): string[] {
  const line = help.split("\n").find(l => /--teleport\b/.test(l));
  if (!line) throw new Error("Teleport対応CLIが必要です。Claude Codeを更新してください。");
  return /--teleport\s+[\[<](?:session|sessionId|session-id|id)[\]>]/i.test(line) ? ["--teleport", cloudId] : ["--teleport"];
}

export function teleportFailure(output: string): string {
  const s = terminalText(output).replace(/(?:session_|cse_)[A-Za-z0-9_-]+/g, "");
  if (/unknown option|unrecognized.*teleport/i.test(s)) return "Teleport対応CLIが必要です。Claude Codeを更新してください。";
  if (/api.?key|subscription|Bedrock|Vertex|Foundry|provider/i.test(s)) return "Teleportはclaude.aiサブスクリプション認証が必要です。利用者自身で認証設定を確認してください。";
  if (/account.*(?:mismatch|different)|same account/i.test(s)) return "Cloudと同じアカウントで認証してください。認証は自動変更しません。";
  if (/repository.*(?:mismatch|different|not found)|same repo/i.test(s)) return "Cloudと同じリポジトリのcwd・GitHub連携を確認してください。";
  if (/branch.*(?:not found|not pushed)|push.*branch|remote.*branch/i.test(s)) return "Cloudの作業ブランチがGitHubへpush済みか確認してください。自動commit/pushはしません。";
  if (/permission denied|access denied|\b403\b|unauthorized/i.test(s)) return "GitHubアクセス権とCloudの認証を確認してください。設定は自動変更しません。";
  if (/dirty|uncommitted|untracked|stash|cancel/i.test(s)) return "ローカル変更の保護確認が必要、または取込みが取り消されました。変更を破棄せず公式Terminalの案内を確認してください。";
  return "Teleportの取込み結果は未確認です。公式Terminalの案内とGit状態を確認してください。自動再試行はしません。";
}

export async function supportedTeleportArgs(bin: string, cwd: string, cloudId: string): Promise<string[]> {
  const p = Bun.spawn([bin, "--help"], { cwd, stdout: "pipe", stderr: "ignore", timeout: 5000 });
  const help = await new Response(p.stdout).text();
  if (await p.exited !== 0) throw new Error(teleportFailure("unknown option"));
  return teleportArgs(help, cloudId);
}

/**
 * The worktree "continue locally" runs in (#1395), so a Local Task working in the clone is never touched. The only Git
 * changes are `worktree add --detach` and one `info/exclude` line; an existing worktree is reused as it is. Returns
 * the worktree's directory. Throws a message for the screen.
 */
export function prepareTeleportWorktree(cwd: string, cloudTaskId: string): string {
  const git = (at: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: at, stdout: "pipe", stderr: "pipe", timeout: 30000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `git ${args[0]} failed`);
    return p.stdout.toString().trim();
  };
  let root: string;
  try { root = realpathSync(git(cwd, "rev-parse", "--show-toplevel")); } catch { throw new Error("作業コピーを作れません。Git リポジトリのcwdを確認してください。"); }
  // The worktree sits at the clone's root, which only stays inside the Workspace when the Workspace is that root.
  if (realpathSync(cwd) !== root) throw new Error("作業コピーを作れません。Workspace はリポジトリのルートにしてください。");
  const dir = teleportWorktreePath(root, cloudTaskId);
  if (!existsSync(dir)) {
    try { git(root, "worktree", "add", "--detach", dir, "HEAD"); } catch (e) { throw new Error(`作業コピーを作れません: ${(e as Error).message}`); }
  } else {
    // A real directory (not a link into the clone) that is a linked worktree of this repository.
    let same = false;
    try {
      same = realpathSync(dir) === dir && realpathSync(git(dir, "rev-parse", "--show-toplevel")) === dir
        && realpathSync(resolve(dir, git(dir, "rev-parse", "--git-common-dir"))) === realpathSync(resolve(root, git(root, "rev-parse", "--git-common-dir")))
        && git(root, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${dir}`);
    } catch { /* not a worktree */ }
    if (!same) throw new Error(`作業コピーの場所 ${dir} に別のものがあります。`);
  }
  try {
    const exclude = resolve(root, git(root, "rev-parse", "--git-path", "info/exclude"));
    const have = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!have.split("\n").includes("/.claude/worktrees/")) appendFileSync(exclude, `${have === "" || have.endsWith("\n") ? "" : "\n"}/.claude/worktrees/\n`);
  } catch { throw new Error("作業コピーをclone の git status から除外できません（info/exclude）。"); }
  return dir;
}
