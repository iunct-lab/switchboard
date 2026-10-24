import { describe, expect, test } from "bun:test";
import { recapOf } from "./recap.ts";

describe("recapOf", () => {
  test("joins streamed chunks per speaker, notes tool calls in one line, and keeps the newest part when long", () => {
    const recap = recapOf([
      { t: "message.delta", role: "user", text: "PR を" },
      { t: "message.delta", role: "user", text: "レビューして" },
      { t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/w" },
      { t: "message.delta", role: "assistant", text: "読みます", messageId: "m1" },
      { t: "tool.call", id: "t1", name: "Bash", input: {}, summary: "gh pr view\n 12" },
      { t: "message.delta", role: "assistant", text: "指摘 2 件", messageId: "m2" },
      { t: "session.end", status: "ok" },
    ]);
    expect(recap).toContain("利用者: PR をレビューして\nエージェント: 読みます\n(ツール Bash: gh pr view 12)\nエージェント: 指摘 2 件");
    expect(recap).toContain("別の機械");

    const long = recapOf([{ t: "message.delta", role: "assistant", text: `${"古".repeat(100)}${"新".repeat(50)}` }], 40);
    expect(long).toContain("前半は省略");
    expect(long).not.toContain("古古");
    expect(long).toContain("新".repeat(40));
  });
});
