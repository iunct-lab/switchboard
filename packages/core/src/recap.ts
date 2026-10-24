import type { AgentEvent } from "@switchboard/protocol";

/**
 * The task so far, from Switchboard's own transcript, for a runner that cannot `--resume` it: the session was made on
 * another machine and its record did not come along (#179). The user's and the runner's words, and one line per tool
 * call; the newest part is kept when it is longer than `maxChars`.
 */
export function recapOf(events: AgentEvent[], maxChars = 24_000): string {
  const body = transcriptLines(events, maxChars);
  return [
    "【Switchboard からの引き継ぎ】このタスクの前のセッションは別の機械で動いており、その記録がこの機械に無いため、新しいセッションで続けます。",
    "以下はこれまでのやり取りの記録です。作業フォルダの状態（未コミットの変更やブランチ）はこの機械のものなので、必要なら確かめてから続けてください。",
    "",
    "<これまでのやり取り>",
    body,
    "</これまでのやり取り>",
    "",
    "利用者の今回のメッセージ:",
  ].join("\n");
}

/**
 * The transcript as lines — the user's and the runner's words, one line per tool call — with the newest part kept
 * when it is longer than `maxChars`. Shared by the recap above and the rubric judge (#1219).
 */
export function transcriptLines(events: AgentEvent[], maxChars: number): string {
  const lines: string[] = [];
  let role: "user" | "assistant" | null = null;
  let text = "";
  const flush = () => {
    if (role && text.trim()) lines.push(`${role === "user" ? "利用者" : "エージェント"}: ${text.trim()}`);
    role = null;
    text = "";
  };
  for (const ev of events) {
    if (ev.t === "message.delta") {
      if (ev.role !== role) flush();
      role = ev.role;
      text += ev.text;
    } else if (ev.t === "tool.call") {
      flush();
      lines.push(`(ツール ${ev.name}: ${ev.summary.replace(/\s+/g, " ").slice(0, 160)})`);
    } else if (ev.t === "session.end") {
      flush();
    }
  }
  flush();
  const body = lines.join("\n");
  return body.length > maxChars ? `…（前半は省略）\n${body.slice(body.length - maxChars)}` : body;
}
