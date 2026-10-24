/**
 * Whether main can be protected now (#852, docs/design/cloud-hosting.md §6.5): the cloud host's root runs what main holds,
 * and the plan could not protect it. Run monthly with merge-audit. Exit 0 = no trigger / 1 = trigger / 2 = cannot tell.
 *   bun scripts/host-trust-check.ts [--file-request]
 */
import { fileRequest } from "./file-request";
import { remoteRepo } from "./local-ci";
import { filingLine } from "./merge-audit";

export function judge(r: { status: number; message: string }): { code: 0 | 1 | 2; line: string } {
  if (r.status === 403 && /Upgrade to GitHub Pro|make this repository public/.test(r.message)) return { code: 0, line: "契機なし: main を保護できない（プランの制限）" };
  if (r.status === 200) return { code: 1, line: "契機: main を保護できる（rulesets の API が応えた）。#852 を見直す" };
  return { code: 2, line: `判定できない（HTTP ${r.status}）` };
}

/** The title is fixed so fileRequest does not file it twice while one is open. */
export function requestFor(source: { date: string; repo: string }): { title: string; body: string } {
  return {
    title: "ホストの root が main を信頼する経路の見直し: main を保護できるようになった",
    body: [
      "## 要望",
      "",
      `${source.repo} の main を保護できるようになった（rulesets の API がプランの制限で拒まなくなった）。\`docs/design/cloud-hosting.md\` §6.5 と #852 を読み、却下した案 B / B' と main の保護を見直す。`,
      "",
      "## 出典",
      "- 誰の言葉: 定期の検査",
      "",
      `\`bun scripts/host-trust-check.ts --file-request\`（定期実行） / ${source.date}`,
    ].join("\n"),
  };
}

/** The status line and the body's `message` of `gh api -i`'s output (status 0 when there is no status line, or when gh failed after a 200: the body may be cut). */
export function parseResponse(out: string, exitCode = 0): { status: number; message: string } {
  const shown = Number(/^HTTP\/\S+ (\d{3})/.exec(out)?.[1] ?? 0);
  // gh exits non-zero for 4xx too, but a 200 it could not finish reading is no answer
  const status = shown === 200 && exitCode !== 0 ? 0 : shown;
  const body = out.slice(out.search(/\r?\n\r?\n/) + 1).trim();
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message;
    return { status, message: typeof message === "string" ? message : "" };
  } catch {
    return { status, message: "" };
  }
}

async function main(args: string[]): Promise<number> {
  const git = Bun.spawnSync(["git", "-C", import.meta.dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
  const repo = remoteRepo(new TextDecoder().decode(git.stdout));
  if (git.exitCode !== 0 || !repo) {
    console.log("判定できない（origin が GitHub の owner/name として読めない）");
    return 2;
  }
  const gh = Bun.spawnSync(["gh", "api", "-i", `repos/${repo}/rulesets`], { stdout: "pipe", stderr: "pipe" });
  const { code, line } = judge(parseResponse(new TextDecoder().decode(gh.stdout), gh.exitCode));
  console.log(line);
  if (code === 1 && args.includes("--file-request")) {
    try {
      console.log(filingLine(await fileRequest(requestFor({ date: new Date().toISOString().slice(0, 10), repo }))));
    } catch (e) {
      console.log(`要望: 起票できなかった（${(e as Error).message}）`);
    }
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
