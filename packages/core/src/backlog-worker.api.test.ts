// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { expect, test } from "bun:test";
import type { BacklogItem } from "@switchboard/protocol";
import { appBoard, claim, release } from "../../../scripts/parallel-guard.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { DECOMPOSED_READY, backlogNextSchedule, boot, closeTried, detailOf, fakeGh, holdingClaude, metaId, metaName, runSchedule, scheduleLogAll, startedTasks, sweepAll, until, useBacklogDaemon } from "./api-test-harness.ts";
import type { CoreServer } from "./server.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

/** fakeGh with the 分解待ち Issue 303 labelled needs-decision, as a PBI waiting for its answer is. */
function askingGh(): GhRunner {
  const fake = fakeGh();
  return async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 303) node.labels.nodes.push({ name: "needs-decision" });
    return { ...r, stdout: JSON.stringify(page) };
  };
}

test("a PBI held by a task that answered it is decomposed once, with GitHub unreachable", async () => {
  const claude = holdingClaude();
  const down = { on: false };
  // from the import on, every call to GitHub fails: what the app keeps is all the daemon has
  const base = await boot(askingGh(), claude.adapter, {}, undefined, (g) => async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : g(args, cwd)));
  down.on = true;
  closeTried();
  const source = core!.db.getWorkspaceBacklogSource(metaId())!;
  core!.db.setBacklogRetryAt(source, Date.now() + 3_600_000); // nothing is sent while the test runs
  const task = async (title: string) => ((await (await fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title, prompt: title, runner: "claude" }) })).json()) as { id: string }).id;
  const [a, b] = [await task("A: 会話"), await task("B: 別の分解")];
  const proof = async (id: string) => ({ "x-task-id": id, "x-task-token": ((await (await fetch(`${base}/api/tasks/${id}/mcp`)).json()) as { token: string }).token });
  const labels = async () => (await detailOf(base, 303)).issue.labels;
  const items = async () => ((await (await fetch(`${base}/api/backlog`)).json()) as { items: BacklogItem[] }).items;
  const child = async (id: string, title: string) => fetch(`${base}/api/backlog`, { method: "POST", headers: await proof(id), body: JSON.stringify({ workspaceId: metaId(), title, body: "", labels: ["type:task"], parent: 303, fields: { Status: "Backlog" } }) });
  const decomposed = () => startedTasks().filter((t) => t.stage?.issue === 303).map((t) => t.stage!.action);
  expect(await labels()).toContain("needs-decision");

  // A holds the PBI by the parallel guard's own call, as the app's Task does
  const guard = { BACKLOG_URL: `${base}/api/backlog`, BACKLOG_WORKSPACE: metaId(), OPS_KIT_TASK_ID: a };
  const board = appBoard(guard);
  expect((await claim(board, 303, false)).held).toBe(true);
  // A writes the answer and the label goes: the PBI now waits to be decomposed
  const as = async (method: string, path: string, body: object) => fetch(`${base}/api/backlog/${path}`, { method, headers: await proof(a), body: JSON.stringify({ workspaceId: metaId(), ...body }) });
  expect((await as("POST", "303/comment", { text: "## 回答\n\nA で" })).status).toBe(202);
  expect((await as("PATCH", "303", { labels: { remove: ["needs-decision"] } })).status).toBe(202);
  expect(await labels()).not.toContain("needs-decision");

  // "バックログを進める" fires: the PBI is not decomposed, and the log says who holds it
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  await runSchedule(base, id);
  expect(decomposed()).toEqual([]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: 占有中: #303（Task ${a}）`));

  // A makes its three children; B, which asks to decompose the same PBI, is refused with A's list
  for (const n of [1, 2, 3]) expect((await child(a, `A の子 ${n}`)).status).toBe(202);
  const refused = await child(b, "B の子");
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain(`Task ${a}（占有）が扱っています`);
  const made = core!.db.listBacklogOperations(source).filter((o) => o.kind === "create" && (o.payload as { parent?: number }).parent === 303);
  expect(made.map((o) => o.taskId)).toEqual([a, a, a]);
  expect((await items()).find((i) => i.number === 303)!.tasks?.total).toBe(3);

  // A lets go before it sets Ready: the next firing picks the PBI, and its Task is told the three children are there (make it Ready, make none)
  await release(board, 303, "回答を書いて分解を終えた");
  for (const t of [a, b]) core!.db.updateTask(t, { status: "done" }); // the runner has room for the stage Task
  await runSchedule(base, id);
  expect(decomposed()).toEqual(["to-tasks"]);

  await until(() => claude.starts.some((x) => x.prompt.includes("PBI #303")));
  const prompt = claude.starts.find((x) => x.prompt.includes("PBI #303"))!.prompt;
  expect([prompt.includes(DECOMPOSED_READY(303, 3)), prompt.includes("既にある Task を作り直さずに")]).toEqual([true, true]);
}, 20_000);
