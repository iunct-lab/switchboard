import { describe, expect, test } from "bun:test";
import type { AgentEvent, EventEnvelope } from "@switchboard/protocol";
import { firstInstruction, foldTranscript, itemText, spanText, transcriptMarkdown, turnReply } from "./transcript.ts";

const env = (evs: AgentEvent[]): EventEnvelope[] => evs.map((ev, i) => ({ taskId: "t", seq: i + 1, ts: i, ev }));
const att = (id: string): AgentEvent => ({ t: "attachment", id, name: `${id}.png`, mime: "image/png", size: 1 });
const user = (text: string): AgentEvent => ({ t: "message.delta", role: "user", text });

test("auto-review decisions remain readable after later status and turn completion", () => {
  const approved = "Codex 自動審査: approved — curl — read-only request";
  const denied = "Codex 自動審査: denied — command — Not authorized";
  const transcript = foldTranscript(env([
    { t: "status", text: approved }, { t: "status", text: denied },
    { t: "status", text: "thread idle" }, { t: "session.end", status: "ok" },
  ]));
  expect(transcript.items.filter((i) => i.kind === "note").map((i) => i.text)).toEqual([approved, denied]);
  expect(transcript.lastStatus).toBe("thread idle");
  expect(transcript.pending).toEqual([]);
});

describe("foldTranscript attachments (#125)", () => {
  test("attachment rows fold into the user message that follows, across the daemon's status note and a --resume session.start", () => {
    const t = foldTranscript(env([att("a"), { t: "status", text: "scope widened" }, att("b"), { t: "session.start", runner: "claude", cwd: "/x" }, user("look")]));
    expect(t.items).toEqual([{ kind: "user", key: "5", at: 0, text: "look", attachments: [expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" })] }]);
  });

  test("a turn whose runner failed before echoing keeps its own row; the next turn gets only its own files", () => {
    const t = foldTranscript(env([att("a"), { t: "error", message: "runner failed to start" }, att("b"), user("second")]));
    expect(t.items.map((i) => i.kind)).toEqual(["user", "note", "user"]);
    expect(t.items[0]).toMatchObject({ kind: "user", key: "att-a", text: "", attachments: [expect.objectContaining({ id: "a" })] });
    expect(t.items[2]).toMatchObject({ kind: "user", text: "second", attachments: [expect.objectContaining({ id: "b" })] });
  });

  test("files still waiting for their turn at the end of the log get a row", () => {
    const t = foldTranscript(env([user("first"), { t: "message.delta", role: "assistant", text: "ok" }, { t: "session.end", status: "ok" }, att("c")]));
    expect(t.items.at(-1)).toMatchObject({ kind: "user", key: "att-c", text: "", attachments: [expect.objectContaining({ id: "c" })] });
  });

  test("a user message without attachments has no attachments field", () => {
    const t = foldTranscript(env([user("plain")]));
    expect(t.items[0]).toEqual({ kind: "user", key: "1", at: 0, text: "plain" });
  });
});

describe("firstInstruction (#1314)", () => {
  test("the first YOU row is the instruction, not a later reply", () => {
    const t = foldTranscript(env([{ t: "session.start", runner: "claude", cwd: "/x" }, user("最初の指示\n二行目"), { t: "message.delta", role: "assistant", text: "ok" }, user("返信")]));
    expect(firstInstruction(t.items)).toEqual({ kind: "user", key: "2", at: 1, text: "最初の指示\n二行目" });
  });

  test("a row of files alone is passed over for the instruction after it", () => {
    const t = foldTranscript(env([att("a"), { t: "error", message: "runner failed to start" }, user("指示"), { t: "message.delta", role: "assistant", text: "ok" }]));
    expect(firstInstruction(t.items)).toMatchObject({ kind: "user", text: "指示" });
  });

  test("no instruction yet is undefined", () => {
    expect(firstInstruction(foldTranscript(env([att("a"), { t: "status", text: "starting" }])).items)).toBeUndefined();
    expect(firstInstruction([])).toBeUndefined();
  });
});

describe("copy text", () => {
  const said = (text: string): AgentEvent => ({ t: "message.delta", role: "assistant", text });
  const call = (id: string): AgentEvent => ({ t: "tool.call", id, name: "Bash", input: { command: "ls" }, summary: "ls" });
  const result = (id: string, ok = true): AgentEvent => ({ t: "tool.result", id, ok, summary: "a\nb\nc" });

  test("itemText keeps newlines and leading spaces", () => {
    const t = foldTranscript(env([user("  run\n    this"), said("一通目\n  二行目\n")]));
    expect(t.items.map(itemText)).toEqual(["  run\n    this", "一通目\n  二行目\n"]);
  });

  test("turnReply joins assistant rows across tool rows with one blank line", () => {
    const t = foldTranscript(env([user("go"), said("一通目"), call("1"), result("1"), said("二通目"), call("2"), result("2"), said("三通目")]));
    const last = t.items.at(-1)!;
    expect(turnReply(t.items, last.key)).toEqual({ text: "一通目\n\n二通目\n\n三通目", rows: 3 });
    expect(turnReply(t.items, t.items[2]!.key).text).toBe("一通目\n\n二通目\n\n三通目");
  });

  test("turnReply leaves out tool, note and end rows and stops at the next user row", () => {
    const t = foldTranscript(env([
      said("before any prompt"), user("first"), said("a"), call("1"), result("1", false), { t: "error", message: "note" }, said("b"),
      { t: "session.end", status: "ok" }, user("second"), said("c"),
    ]));
    const b = t.items.find((i) => i.kind === "assistant" && i.text === "b")!;
    expect(turnReply(t.items, b.key)).toEqual({ text: "a\n\nb", rows: 2 });
    expect(turnReply(t.items, t.items[0]!.key)).toEqual({ text: "before any prompt", rows: 1 });
    expect(turnReply(t.items, t.items.at(-1)!.key)).toEqual({ text: "c", rows: 1 });
    expect(turnReply(t.items, "missing")).toEqual({ text: "", rows: 0 });
  });

  test("turnReply from a user row's key is the reply that follows it, not the turn before", () => {
    const t = foldTranscript(env([user("first"), said("old"), user("second"), said("new")]));
    expect(turnReply(t.items, t.items[2]!.key)).toEqual({ text: "new", rows: 1 });
    expect(turnReply(t.items, t.items[0]!.key)).toEqual({ text: "old", rows: 1 });
  });

  test("transcriptMarkdown keeps a tool row on one line when its summary has newlines", () => {
    const t = foldTranscript(env([{ t: "tool.call", id: "1", name: "Bash", input: {}, summary: "echo a\n  echo b" }]));
    expect(transcriptMarkdown(t.items, "claude")).toBe("- Bash echo a echo b …");
  });

  test("transcriptMarkdown has headings, one-line tool rows without input or result, attachment names and the end", () => {
    const t = foldTranscript(env([
      att("a"), att("b"), user("look\n  here"), said("seen"), call("1"), result("1"), call("2"), result("2", false),
      { t: "error", message: "rate limited" }, said("done"), { t: "session.end", status: "error", summary: "boom" },
    ]));
    expect(transcriptMarkdown(t.items, "claude")).toBe([
      "### YOU", "look\n  here", "添付: a.png, b.png", "### claude", "seen", "- Bash ls ✓", "- Bash ls ✕", "rate limited",
      "### claude", "done", "— エラー: boom —",
    ].join("\n\n"));
    expect(transcriptMarkdown(foldTranscript(env([user("x"), { t: "session.end", status: "ok", summary: "fine" }])).items, "codex")).toBe("### YOU\n\nx\n\n— 完了 —");
    expect(transcriptMarkdown(foldTranscript(env([user("x"), { t: "session.end", status: "aborted" }])).items, "codex")).toBe("### YOU\n\nx\n\n— 中断 —");
  });

  test("transcriptMarkdown of a running turn ends with the text so far", () => {
    const t = foldTranscript(env([user("go"), said("書き"), said("かけ"), call("1")]));
    expect(transcriptMarkdown(t.items, "claude")).toBe("### YOU\n\ngo\n\n### claude\n\n書きかけ\n\n- Bash ls …");
  });
});

describe("assistant generated attachments (#124)", () => {
  const said = (text: string): AgentEvent => ({ t: "message.delta", role: "assistant", text });
  // what core records for a runner file it registers: the absolute path, then an attachment named after it
  const file = (id: string): AgentEvent => ({ t: "artifact", kind: "file", path: `/generated/${id}.png` });

  test("assistant gets generated files across tool rows, but reply uploads stay with the user", () => {
    const t = foldTranscript(env([user("go"), said("report"), { t: "tool.call", id: "1", name: "Write", input: {} }, file("out"), att("out"), att("upload"), { t: "status", text: "scope" }, user("next")]));
    expect(t.items[1]).toMatchObject({ kind: "assistant", text: "report", attachments: [expect.objectContaining({ id: "out" })] });
    expect(t.items.at(-1)).toMatchObject({ kind: "user", text: "next", attachments: [expect.objectContaining({ id: "upload" })] });
  });

  test("assistant file before text creates a row immediately and subsequent text merges into it", () => {
    const evs = env([user("go"), file("out"), att("out")]);
    expect(foldTranscript(evs).items.at(-1)).toMatchObject({ kind: "assistant", text: "", attachments: [expect.objectContaining({ id: "out" })] });
    const t = foldTranscript(env([user("go"), file("out"), att("out"), said("ready"), file("out2"), att("out2"), { t: "session.end", status: "ok" }]));
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant", "end"]);
    expect(t.items[1]).toMatchObject({ text: "ready", attachments: [expect.objectContaining({ id: "out" }), expect.objectContaining({ id: "out2" })] });
  });

  test("assistant files do not attach to an older turn", () => {
    const t = foldTranscript(env([user("first"), said("old"), { t: "session.end", status: "ok" }, user("second"), file("new"), att("new"), { t: "session.end", status: "ok" }]));
    expect(t.items[1]).not.toHaveProperty("attachments");
    expect(t.items[4]).toMatchObject({ kind: "assistant", text: "", attachments: [expect.objectContaining({ id: "new" })] });
  });

  test("assistant generated file folds by sequence even when websocket broadcasts attachment before artifact", () => {
    const evs = env([user("go"), file("out"), att("out"), said("ready")]);
    expect(foldTranscript([evs[0]!, evs[2]!, evs[1]!, evs[3]!])).toEqual(foldTranscript(evs));
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test("assistant following an unregistered artifact does not steal a later user upload", () => {
    const t = foldTranscript(env([user("go"), file("gone"), said("no file"), att("upload"), user("next")]));
    expect(t.items[1]).not.toHaveProperty("attachments");
    expect(t.items.at(-1)).toMatchObject({ kind: "user", attachments: [expect.objectContaining({ id: "upload" })] });
  });

  test("an applied staged change before a reply's upload leaves the upload with the user", () => {
    const applied: AgentEvent = { t: "artifact", kind: "file", path: "assets/upload.png" };
    const t = foldTranscript(env([user("go"), said("staged"), { t: "session.end", status: "ok" }, applied, att("upload"), user("next")]));
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant", "end", "user"]);
    expect(t.items.at(-1)).toMatchObject({ kind: "user", attachments: [expect.objectContaining({ id: "upload" })] });
  });

  test("copied text names the assistant's files, and a file-only row adds no blank reply", () => {
    const t = foldTranscript(env([user("go"), file("out"), att("out"), { t: "tool.call", id: "1", name: "Write", input: {} }, said("ready")]));
    expect(transcriptMarkdown(t.items, "dak")).toBe("### YOU\n\ngo\n\n### dak\n\n添付: out.png\n\n- Write …\n\n### dak\n\nready");
    expect(turnReply(t.items, t.items[0]!.key)).toEqual({ text: "ready", rows: 1 });
  });
});

describe("artifact.saved (#1778)", () => {
  test("becomes an artifact row after the reply that carried the fence, with the id to open and the title", () => {
    const t = foldTranscript(env([user("作って"), { t: "message.delta", role: "assistant", text: "できました。\n```switchboard-artifact\n{\"path\":\"report.html\"}\n```\n" }, { t: "artifact.saved", id: "art_1", title: "週報" }, { t: "session.end", status: "ok" }]));
    expect(t.items.map((it) => it.kind)).toEqual(["user", "assistant", "artifact", "end"]);
    expect(t.items[2]).toEqual({ kind: "artifact", key: "3", at: 2, id: "art_1", title: "週報" });
  });
  test("a reply that goes on after the fence stays one row, with the artifact rows after it", () => {
    const fence = "```switchboard-artifact\n{\"path\":\"report.html\"}\n```\n";
    const t = foldTranscript(env([user("作って"), { t: "message.delta", role: "assistant", text: `作りました。\n${fence}`, messageId: "m1" }, { t: "artifact.saved", id: "art_1", title: "週報" }, { t: "message.delta", role: "assistant", text: "中身は売上の傾向です。", messageId: "m1" }, { t: "session.end", status: "ok" }]));
    expect(t.items.map((it) => it.kind)).toEqual(["user", "assistant", "artifact", "end"]);
    expect(t.items[1]).toMatchObject({ kind: "assistant", text: `作りました。\n${fence}中身は売上の傾向です。`, messageId: "m1" });
    expect(transcriptMarkdown(t.items, "claude")).toBe(`### YOU\n\n作って\n\n### claude\n\n作りました。\n${fence}中身は売上の傾向です。\n\n- 成果物: 週報\n\n— 完了 —`);
    // two fences in one reply: two rows after the one reply; a reply of another message is its own row
    const u = foldTranscript(env([user("作って"), { t: "message.delta", role: "assistant", text: `A\n${fence}`, messageId: "m1" }, { t: "artifact.saved", id: "art_1", title: "週報" }, { t: "message.delta", role: "assistant", text: `B\n${fence}`, messageId: "m1" }, { t: "artifact.saved", id: "art_2", title: "傾向" }, { t: "message.delta", role: "assistant", text: "C", messageId: "m1" }, { t: "message.delta", role: "assistant", text: "D", messageId: "m2" }, { t: "session.end", status: "ok" }]));
    expect(u.items.map((it) => (it.kind === "assistant" ? `assistant:${it.text.replace(/\n[^]*?```\n/g, "")}` : it.kind))).toEqual(["user", "assistant:ABC", "artifact", "artifact", "assistant:D", "end"]);
  });
  test("transcriptMarkdown writes the row as one line, like a tool row", () => {
    const t = foldTranscript(env([user("作って"), { t: "message.delta", role: "assistant", text: "できました。" }, { t: "artifact.saved", id: "art_1", title: "週報" }, { t: "session.end", status: "ok" }]));
    expect(transcriptMarkdown(t.items, "claude")).toBe("### YOU\n\n作って\n\n### claude\n\nできました。\n\n- 成果物: 週報\n\n— 完了 —");
    // a title with a newline stays one line, like a tool row's summary
    const u = foldTranscript(env([user("作って"), { t: "artifact.saved", id: "art_2", title: "週報\n 10 月" }, { t: "session.end", status: "ok" }]));
    expect(transcriptMarkdown(u.items, "claude")).toBe("### YOU\n\n作って\n\n- 成果物: 週報 10 月\n\n— 完了 —");
    expect(itemText(t.items[2]!)).toBe("");
  });
});

describe("times (#2254)", () => {
  const at = (pairs: [number, AgentEvent][]): EventEnvelope[] => pairs.map(([ts, ev], i) => ({ taskId: "t", seq: i + 1, ts, ev }));
  const call: AgentEvent = { t: "tool.call", id: "c1", name: "Bash", input: {}, summary: "ls" };
  const result: AgentEvent = { t: "tool.result", id: "c1", ok: true, summary: "" };

  test("each row keeps its first event's ts; a tool row its call and result; the end row the turn's span", () => {
    const t = foldTranscript(at([
      [0, user("go")], [1000, call], [3500, result],
      [4000, { t: "message.delta", role: "assistant", text: "do" }], [4100, { t: "message.delta", role: "assistant", text: "ne" }],
      [252000, { t: "session.end", status: "ok" }],
    ]));
    expect(t.items.map((i) => [i.kind, i.at])).toEqual([["user", 0], ["tool", 1000], ["assistant", 4000], ["end", 252000]]);
    expect(t.items[1]).toMatchObject({ endAt: 3500 });
    expect(t.items[2]).toMatchObject({ text: "done" });
    expect(t.items[3]).toMatchObject({ durationMs: 252000 });
  });

  test("the second turn counts from the event after the first turn's end", () => {
    const t = foldTranscript(at([
      [0, user("go")], [5000, { t: "session.end", status: "ok" }],
      [60000, user("again")], [61000, { t: "message.delta", role: "assistant", text: "ok" }], [125000, { t: "session.end", status: "aborted" }],
    ]));
    const ends = t.items.filter((i) => i.kind === "end");
    expect(ends.map((e) => [e.at, e.durationMs])).toEqual([[5000, 5000], [125000, 65000]]);
  });

  test("a tool with no result yet has no endAt", () => {
    const t = foldTranscript(at([[0, user("go")], [1000, call]]));
    expect(t.items[1]).toMatchObject({ kind: "tool", at: 1000 });
    expect(t.items[1]).not.toHaveProperty("endAt");
  });

  test("a result whose call was never seen still has its row's ts", () => {
    const t = foldTranscript(at([[3500, result]]));
    expect(t.items[0]).toMatchObject({ kind: "tool", at: 3500, endAt: 3500 });
  });

  test("spanText: under a second, then minutes and seconds", () => {
    expect(spanText(400)).toBe("<1 秒");
    expect(spanText(65000)).toBe("1 分 5 秒");
  });
});
