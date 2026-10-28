import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent, EventEnvelope, Task, TeleportProgress } from "@switchboard/protocol";
import { CloudSessionNotice, CloudSourceTag, teleportView } from "./components/ui.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { Brief } from "./components/Brief.tsx";
import { foldTranscript, transcriptMarkdown } from "./transcript.ts";
const ref = { id: "session_0123456789abcdefghijklmn", url: "https://claude.ai/code/session_0123456789abcdefghijklmn" };
const task: Task = { id: "task_cloud", executionMode: "cloud", cloudSession: ref, sourceCloudTaskId: null, workspaceId: null, title: "Cloud", runner: "claude", cwd: "/fixture", scope: ["/fixture"], status: "idle", runnerSessionId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 };
const noop = () => {};
const events = (list: AgentEvent[]): EventEnvelope[] => list.map((ev, i) => ({ taskId: task.id, seq: i+1, ts: i, ev }));

test("Cloud notice only links canonical official references and always explains unknown state", () => {
  const html = renderToStaticMarkup(createElement(CloudSessionNotice, { session: ref }));
  expect(html).toContain(`href="${ref.url}"`); expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("公式Cloudで続ける"); expect(html).toContain("状態は未確認");
  const missing = renderToStaticMarkup(createElement(CloudSessionNotice, { session: null })); expect(missing).not.toContain("href="); expect(missing).toContain("参照を確認できていません");
  const invalid = renderToStaticMarkup(createElement(CloudSessionNotice, { session: { ...ref, url: "https://evil.example" } })); expect(invalid).not.toContain("evil.example"); expect(invalid).not.toContain("href=");
});

test("Cloud Task view and Brief direct unsupported Local operations to official Web", () => {
  const html = renderToStaticMarkup(createElement(TaskView, { task, onSend: async () => {}, onPermission: noop, onError: noop, onBrief: noop, pty: true }));
  expect(html).toContain("開始 1/1 09:00 · 1/1 09:00 から状態未確認"); // a Cloud Task's head says when too, in JST (#2030)
  expect(html).toContain("公式Cloudで続ける"); expect(html).not.toContain('class="composer"'); expect(html).toContain("ローカルで続ける"); expect(html).not.toContain("差分</button>");
  const brief = renderToStaticMarkup(createElement(Brief, { task, ledger: null, onAbort: noop, open: true, onClose: noop }));
  expect(brief).toContain("公式 Web"); expect(brief).not.toContain("未設定 — 再開時"); expect(brief).not.toContain("エンドポイントを発行");
  const local = renderToStaticMarkup(createElement(TaskView, { task: { ...task, executionMode: "local", cloudSession: null }, onSend: async () => {}, onPermission: noop, onError: noop, onBrief: noop })); expect(local).toContain('class="composer"'); expect(local).not.toContain("公式Cloudで続ける");
});

test("creation identity and safe failure remain readable without a successful turn end", () => {
  const transcript = foldTranscript(events([{ t: "cloud.session.created", ...ref }, { t: "error", message: "Private リポジトリへの権限を確認してください" }]));
  expect(transcript.items.map(i => i.kind)).toEqual(["note", "note"]);
  expect(transcript.items).toContainEqual(expect.objectContaining({ text: expect.stringContaining(ref.id) }));
  expect(transcript.items).toContainEqual(expect.objectContaining({ text: "Private リポジトリへの権限を確認してください" }));
});

test("Cloud creation is informational while a real failure remains red in the rendered conversation", () => {
  const failure = "Private リポジトリへの権限を確認してください";
  const log = events([{ t: "cloud.session.created", ...ref }, { t: "error", message: failure }]);
  const html = renderToStaticMarkup(createElement(TaskView, {
    task, detail: { task, events: log, cost: { costUsd: 0, tokens: 0 }, history: null, attachments: [] },
    onSend: async () => {}, onPermission: noop, onError: noop, onBrief: noop,
  }));
  expect(html).toContain(`<div class="hint">Cloudセッションを作成: ${ref.id}。Cloud側の状態は未確認です。</div>`);
  expect(html).toContain(`<div class="note">${failure}</div>`);
  expect(html).toContain(`href="${ref.url}"`);
  expect(html).toContain("Cloud側の状態は未確認です。開始プロセスの終了は、Cloud作業の完了を意味しません。");
  const markdown = transcriptMarkdown(foldTranscript(log).items, "claude");
  expect(markdown).toContain(`Cloudセッションを作成: ${ref.id}`);
  expect(markdown).toContain(failure);
  expect(markdown).not.toContain("— 完了 —");
});

// #1131: render the real notice and TaskView; invalid IDs must not create an enabled entry.
test("Teleport entry requires a canonical stopped Cloud reference and PTY", () => {
  const render = (t: Task, pty = true) => renderToStaticMarkup(createElement(TaskView, { task: t, onSend: async () => {}, onPermission: noop, onError: noop, onBrief: noop, pty }));
  expect(render(task)).toContain('<button class="btn">ローカルで続ける</button>');
  for (const t of [{ ...task, cloudSession: null }, { ...task, cloudSession: { ...ref, url: "https://evil.example" } }, { ...task, cloudSession: { ...ref, id: "unverified" } }, { ...task, status: "running" as const }, { ...task, status: "waiting" as const }]) {
    expect(render(t)).toContain('<button class="btn" disabled="">ローカルで続ける</button>');
  }
  expect(render(task, false)).toContain('<button class="btn" disabled="">ローカルで続ける</button>');
  expect(render({ ...task, cloudSession: null })).toContain("Cloud IDが未確認");
  expect(render(task, false)).toContain("PTYを利用できません");
  expect(render({ ...task, status: "running" })).toContain("開始プロセスの終了後");
});

// #1306: "continue locally" shows its progress on the Cloud Task screen; the words live in one function.
test("teleportView words each phase and only needs-input sends the person to the terminal", () => {
  expect(teleportView(null)).toBeNull();
  expect(teleportView({ phase: "teleporting" })).toMatchObject({ text: "公式CLIでTeleport中…", active: true, answerInTerminal: false });
  expect(teleportView({ phase: "needs-input", question: "Stash? [y/N]" })).toMatchObject({ question: "Stash? [y/N]", answerInTerminal: true, active: true });
  for (const phase of ["exiting", "importing"] as const) expect(teleportView({ phase })).toMatchObject({ text: "Local Taskへ取込み中…", active: true });
  expect(teleportView({ phase: "done", localTaskId: "t" })).toMatchObject({ text: "取込みを確認しました", active: false });
  expect(teleportView({ phase: "unconfirmed", message: "未確認です" })).toMatchObject({ text: "未確認です", active: false, answerInTerminal: false });
});

test("a running Teleport disables the button and a question offers the terminal", () => {
  const render = (teleport: TeleportProgress | null) => renderToStaticMarkup(createElement(TaskView, { task, onSend: async () => {}, onPermission: noop, onError: noop, onBrief: noop, pty: true, teleport }));
  expect(render({ phase: "importing" })).toContain('<button class="btn" disabled="">ローカルで続ける</button>');
  const asking = render({ phase: "needs-input", question: "Uncommitted changes. Stash? [y/N]" });
  expect(asking).toContain("ターミナルで答える"); expect(asking).toContain("Stash? [y/N]");
  expect(render({ phase: "teleporting" })).not.toContain("ターミナルで答える");
});

// #1395: the continuation runs in its own worktree, so the screen says where.
test("Cloud Task and Local Task screens show the work copy the continuation runs in", () => {
  const wc = "/fixture/.claude/worktrees/teleport-task_cloud";
  const local: Task = { ...task, id: "task_local", executionMode: "local", cloudSession: null, sourceCloudTaskId: task.id, cwd: wc, title: "続き" };
  const cloudNotice = renderToStaticMarkup(createElement(CloudSessionNotice, { session: ref, localTasks: [local] }));
  expect(cloudNotice).toContain(`作業コピー: ${wc}`);
  const detail = (t: Task, extra: object) => ({ task: t, events: [], cost: { costUsd: 0, tokens: 0 }, history: null, attachments: [], sourceCloudTask: null, localContinuations: [], ...extra }) as never;
  const cloudBrief = renderToStaticMarkup(createElement(Brief, { task, detail: detail(task, { localContinuations: [local] }), ledger: null, onAbort: noop, open: true, onClose: noop }));
  expect(cloudBrief).toContain(`作業コピー: ${wc}`);
  const localBrief = renderToStaticMarkup(createElement(Brief, { task: local, detail: detail(local, { sourceCloudTask: task }), ledger: null, onAbort: noop, open: true, onClose: noop }));
  expect(localBrief).toContain(`作業コピー: ${wc}`);
});

// #1634: the imported Local Task says where it came from in the sticky head, and the switch line only right after the switch.
test("an imported Local Task shows its Cloud source in the sticky head, and the switch line only when switched", () => {
  const local: Task = { ...task, id: "task_local", executionMode: "local", cloudSession: null, sourceCloudTaskId: task.id, title: "Cloud" };
  const detail = (sourceCloudTask: Task | null) => ({ task: local, events: [], cost: { costUsd: 0, tokens: 0 }, history: null, attachments: [], sourceCloudTask, localContinuations: [] }) as never;
  const render = (sourceCloudTask: Task | null, switchedFromCloud?: boolean) => renderToStaticMarkup(createElement(TaskView, { task: local, detail: detail(sourceCloudTask), switchedFromCloud, onSend: async () => {}, onPermission: noop, onError: noop, onBrief: noop }));
  const head = (html: string) => html.slice(html.indexOf('class="task-head"'), html.indexOf('class="subtabs"'));
  const opened = render(task);
  expect(head(opened)).toContain("Cloudから取込み"); expect(head(opened)).toContain("元Cloud Taskを開く");
  expect(opened).not.toContain("切り替わりました"); expect(opened).not.toContain("Cloudから取り込んだLocalセッションです"); // the card after the conversation is gone
  const switched = render(task, true);
  expect(head(switched)).toContain('class="hint switched-from-cloud" role="status"'); expect(head(switched)).toContain("Cloud Task「Cloud」から、取り込んだLocal Taskに切り替わりました");
  const plain = render(null, true);
  expect(plain).not.toContain("Cloudから取込み"); expect(plain).not.toContain("元Cloud Taskを開く"); expect(plain).not.toContain("切り替わりました");
  const opens: string[] = [];
  const tag = CloudSourceTag({ source: task, switched: false, onOpen: () => opens.push(task.id) });
  const button = (tag.props as { children: { type: string; props: { onClick: () => void } }[] }).children.find((c) => c?.type === "button")!;
  button.props.onClick();
  expect(opens).toEqual([task.id]);
});
