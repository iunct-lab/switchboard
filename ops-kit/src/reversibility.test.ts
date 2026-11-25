// test-reads: ops-kit/reversibility.json
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askProceed } from "./lint.ts";
import { kindRefusal, loadAskTable, proceedLine, proceedRefusal, REVERSIBILITY_FILE, tableRefusal, type AskPlace, type AskTable } from "./reversibility.ts";

const W = mkdtempSync(join(tmpdir(), "ops-kit.reversibility."));
afterAll(() => rmSync(W, { recursive: true, force: true }));

const ask = (line: string, more = "") => `## 判断待ち\n**問い**: どちらの書き方にするか\n**選択肢**:\n- A: 関数に出す — 影響: 呼び出しが 1 つ増える\n- B: そのまま — 影響: 重複が残る\n**推奨**: A — 短い\n${line}\n${more}`;
const GO = "**進め方**: 推奨で進める（種類: implementation-choice） — 戻せる";
// where the questions of these tests stand: Task 21 of PBI 20 (Tasks 21 and 22), which names one file and one directory
const TOP = [{ name: "src", dir: true }, { name: "docs", dir: true }, { name: "scripts", dir: true }, { name: "package.json", dir: false }];
const TASK: AskPlace = { issue: { number: 21, body: "## 手順\n1. `src/names.ts`: 関数を出す\n2. `docs/design/` の該当の節を直す", labels: ["type:task"] }, pbi: { number: 20, tasks: [21, 22] }, top: TOP };
const PBI: AskPlace = { issue: { number: 20, body: "## ユーザーストーリー\n…", labels: ["type:pbi"] }, pbi: { number: 20, tasks: [21, 22] }, top: TOP };
const table = (kinds: Record<string, string>, stops = ["マージ", "delete"]): AskTable => ({ kinds: new Map(Object.entries(kinds)), stops });

test("the line as written: the kind is what its writer proposes, in either kind of brackets; a line inside a fence is no line", () => {
  expect(proceedLine(ask(GO))).toEqual({ said: "recommended", kind: "implementation-choice" });
  expect(proceedLine(ask("**進め方**: 推奨で進める(種類: wording)"))).toEqual({ said: "recommended", kind: "wording" });
  expect(proceedLine(ask("**進め方**: 推奨で進める — 戻せる"))).toEqual({ said: "recommended", kind: null });
  expect(proceedLine(ask("**進め方**: 止めて待つ — お金が動く"))).toEqual({ said: "wait", kind: null });
  expect(proceedLine(ask("```\n" + GO + "\n```"))).toBeNull();
  expect(proceedLine(ask("**進め方**: 推奨で進めるかは未定"))).toBeNull();
});

test("the work goes on only for a kind the table lists as compensable: no kind, an unknown kind, a kind listed as irreversible or reversible, and a table that cannot be read all stop and ask", () => {
  const t = table({ "implementation-choice": "compensable", "drop-data": "irreversible", "restart": "reversible" });
  expect(proceedRefusal(ask(GO, "`src/names.ts` の関数名"), t, TASK)).toBeNull();
  expect(proceedRefusal(ask("**進め方**: 推奨で進める — 戻せる"), t)).toContain("種類が書かれていない");
  expect(proceedRefusal(ask("**進め方**: 推奨で進める（種類: anything-i-like）"), t)).toContain("表に無い");
  expect(proceedRefusal(ask("**進め方**: 推奨で進める（種類: drop-data）"), t)).toContain("irreversible");
  expect(proceedRefusal(ask("**進め方**: 推奨で進める（種類: restart）"), t)).toContain("compensable の種類だけ");
  expect(proceedRefusal(ask(GO), null)).toContain("表（ops-kit/reversibility.json）を読めない");
  // a question that waits is not the table's to refuse
  expect(proceedRefusal(ask("**進め方**: 止めて待つ — 公開"), t)).toBeNull();
});

test("a safety confirmation is never gone on from, whatever kind its writer gave it: a merge, a promotion, a [聞く] reason, publishing, deleting, permissions, money, keys", () => {
  const t = loadAskTable()!;
  for (const more of ["PR #12 をマージしてよいか", "この版に昇格する", "[聞く] セキュリティ（security:gates）: scripts/merge-gate.ts", "公開リポジトリへ出す", "古い表を削除する", "トークンの権限を広げる", "課金が増える", "鍵を作り直す", "deploy to production", "delete the bucket", "本番の DB を移行する"]) {
    expect({ more, refusal: proceedRefusal(ask(GO, more), t) }).toEqual({ more, refusal: expect.stringContaining("安全の確認に当たる語") });
    expect(askProceed(ask(GO, more))).toBe("wait");
  }
});

test("the stop words are looked for in the whole question: an operation written in a code fence, a quoted block or an inline span stops it as the same words in a sentence do", () => {
  const t = loadAskTable()!;
  for (const more of ["```\ngit merge x\n```", "```bash\ngh repo edit --visibility public\n```", "~~~\naws s3 rb s3://bucket --force\n~~~", "```sql\nDROP TABLE tasks;\n```", "> 古い表を削除する", "`git push --force` で直す", "外へ出す案", "古い枝は捨てる", "```\nrm -rf data\n```"]) {
    expect({ more, refusal: proceedRefusal(ask(GO, more), t, TASK) }).toEqual({ more, refusal: expect.stringContaining("安全の確認に当たる語") });
    expect({ more, proceed: askProceed(ask(GO, more), TASK) }).toEqual({ more, proceed: "wait" });
  }
  // the same question without them goes on
  expect(proceedRefusal(ask(GO, "`src/names.ts` の\n```ts\nexport const nameOf = (x: string) => x;\n```"), t, TASK)).toBeNull();
});

test("the kind is a proposal checked against where the question stands: a task-order question names no file and nothing outside one PBI, an implementation or wording question names only paths the Task names; what cannot be checked asks", () => {
  const t = loadAskTable()!;
  const order = (more = "") => ask("**進め方**: 推奨で進める（種類: task-order）", `#21 と #22 のどちらを先にするか\n${more}`);
  expect(proceedRefusal(order(), t, PBI)).toBeNull();
  expect(proceedRefusal(order(), t, TASK)).toBeNull(); // asked on one of the PBI's Tasks
  expect(proceedRefusal(order("`src/names.ts` を先に直す"), t, PBI)).toContain("ファイルを名指している（src/names.ts）");
  expect(proceedRefusal(order("#99 の後にする"), t, PBI)).toContain("PBI #20 とその Task でないもの（#99）");
  expect(proceedRefusal(order(), t, { ...PBI, pbi: null })).toContain("PBI とその Task を読めず");
  // implementation-choice / wording: on a Task, inside what it names (a file, or anything under a directory it names)
  for (const kind of ["implementation-choice", "wording"]) {
    const go = (more = "") => ask(`**進め方**: 推奨で進める（種類: ${kind}）`, more);
    expect(proceedRefusal(go("`src/names.ts` の関数名"), t, TASK)).toBeNull();
    expect(proceedRefusal(go("docs/design/asks.md の節の題"), t, TASK)).toBeNull();
    expect(proceedRefusal(go("`scripts/gate.ts` も直す"), t, TASK)).toContain("Task #21 の名指しの外のパス（scripts/gate.ts）");
    expect(proceedRefusal(go("```\nsed -i s/a/b/ src/other.ts\n```"), t, TASK)).toContain("名指しの外のパス（src/other.ts）"); // a path in a fence counts
    expect(proceedRefusal(go("`src/` 全体の書き方"), t, TASK)).toContain("名指しの外のパス（src/）"); // wider than the file the Task names
    expect(proceedRefusal(go(), t, PBI)).toContain("Task の Issue に書いた問いだけ");
    expect(proceedRefusal(go(), t, { ...TASK, issue: { ...TASK.issue, body: "## 手順\n1. 調べる" } })).toContain("触るファイルを名指していない");
  }
  // not known where it stands, or no checkout to read the paths against: asked, never guessed
  expect(proceedRefusal(ask(GO), t)).toContain("問いの置かれた Issue を読めず");
  expect(proceedRefusal(ask(GO), t, null)).toContain("問いの置かれた Issue を読めず");
  expect(proceedRefusal(ask(GO), t, { ...TASK, top: [] })).toContain("リポジトリの最上位の名前を読めず");
  expect(askProceed(ask(GO))).toBe("wait");
  // a compensable kind the table gains without a rule here is not let through on its name
  expect(kindRefusal("new-kind", ask(GO), TASK)).toContain("確かめる規則が無い");
  // the table's part alone (a reader without a checkout) says nothing about the place
  expect(tableRefusal(ask(GO), t)).toBeNull();
});

test("a question that names nothing cannot show its kind", () => {
  const t = loadAskTable()!;
  const order = (more: string) => ask("**進め方**: 推奨で進める（種類: task-order）", more);
  // task-order: no number at all, or only the PBI itself, names no Task of it
  for (const more of ["どちらを先にするか", "#20 の中の順序をどうするか"]) {
    expect(proceedRefusal(order(more), t, PBI)).toContain("PBI #20 の Task を 1 つも名指していない");
    expect(askProceed(order(more), PBI)).toBe("wait");
  }
  // implementation-choice / wording: a Task that names paths, a question that names none
  for (const kind of ["implementation-choice", "wording"]) {
    const go = ask(`**進め方**: 推奨で進める（種類: ${kind}）`, "関数の名前をどうするか");
    expect(proceedRefusal(go, t, TASK)).toContain(`種類 ${kind} の問いがパスを 1 つも名指していない`);
    expect(askProceed(go, TASK)).toBe("wait");
  }
});

test("realistic questions that should go on do: a name inside one file of the Task, the order of two Tasks of a PBI, the wording of a label", () => {
  const t = loadAskTable()!;
  const top = [{ name: "ops-kit", dir: true }, { name: "apps", dir: true }, { name: "scripts", dir: true }, { name: "packages", dir: true }, { name: "docs", dir: true }];
  // a Task that moves the reading of a Task's paths into the kit
  const moving: AskPlace = { issue: { number: 5429, labels: ["type:task"], body: "## 手順\n1. `ops-kit/src/task-paths.ts`（新規）: `pathsIn`・`scopeIn`・`overlaps` を移す\n2. `scripts/task-paths.ts`: キットから読み直すだけにする" }, pbi: { number: 5400, tasks: [5429, 5430] }, top };
  const naming = ["## 判断待ち", "**問い**: `ops-kit/src/task-paths.ts` へ移した関数の名前を、いまの `scopeIn` のままにするか、役割の分かる `namedScope` に変えるか", "**選択肢**:", "- A: `scopeIn` のまま — 影響: 呼ぶ側の import は名前を変えずに済む", "- B: `namedScope` に変える — 影響: 呼ぶ側 3 か所の名前の置き換えが要る", "**推奨**: A — 移すだけの Task なので差分を小さく保つ。変えるなら後の PR で名前を置き換えれば済む", "**進め方**: 推奨で進める（種類: implementation-choice） — 名前 1 つで、置き換えで戻せる", "**止めた場所**: Task #5429（ブランチ sb/5429-task-paths）"].join("\n");
  expect(proceedRefusal(naming, t, moving)).toBeNull();
  expect(askProceed(naming, moving)).toBe("recommended");
  // a PBI whose Tasks can be done in either order
  const insights: AskPlace = { issue: { number: 4896, labels: ["type:pbi"], body: "## ユーザーストーリー\n介入の多い Task と要望の行を Insights で見たい" }, pbi: { number: 4896, tasks: [4955, 4956, 4957, 4958, 4959] }, top };
  const order = ["## 判断待ち", "**問い**: #4955（介入の多い Task を先に出す）と #4956（要望の行）のどちらを先に実装するか", "**選択肢**:", "- A: #4955 → #4956 — 影響: 一覧の並びが先に変わり、要望の行はその並びの上に足す", "- B: #4956 → #4955 — 影響: 要望の行を足したあとで並びを変えるので、行の位置のテストを書き直す", "**推奨**: A — #4956 のテストが #4955 の並びを前提に書ける", "**進め方**: 推奨で進める（種類: task-order） — Issue の順を入れ替えるだけで戻せる", "**止めた場所**: PBI #4896（Task に着手する前）"].join("\n");
  expect(proceedRefusal(order, t, insights)).toBeNull();
  expect(askProceed(order, insights)).toBe("recommended");
  // a Task that changes one label of the Backlog screen
  const label: AskPlace = { issue: { number: 5501, labels: ["type:task"], body: "## 手順\n1. `apps/web/src/i18n/backlog.ts`: `taskDecision` の文言を直す\n2. `apps/web/src/components/BacklogRow.tsx`: 幅を確かめる" }, pbi: { number: 5490, tasks: [5501] }, top };
  const wording = ["## 判断待ち", "**問い**: Backlog の行に出すラベル `taskDecision`（`apps/web/src/i18n/backlog.ts`）の文言を「の判断待ち」のままにするか「が回答を待っています」にするか", "**選択肢**:", "- A: 「の判断待ち」のまま — 影響: Home の「判断待ち」と同じ語で揃う", "- B: 「が回答を待っています」 — 影響: スマホ縦で 1 行に収まらず折り返す", "**推奨**: A — 語が揃い、幅も今のまま", "**進め方**: 推奨で進める（種類: wording） — 文言 1 行で、後の PR で直せる", "**止めた場所**: Task #5501（ブランチ sb/5501-backlog-label）"].join("\n");
  expect(proceedRefusal(wording, t, label)).toBeNull();
  expect(askProceed(wording, label)).toBe("recommended");
  // the same three with the kind that does not fit their place stop
  expect(proceedRefusal(naming.replace("implementation-choice", "task-order"), t, moving)).toContain("ファイルを名指している");
  expect(proceedRefusal(order.replace("task-order", "wording"), t, insights)).toContain("Task の Issue に書いた問いだけ");
});

test("the table in the repository: its question kinds are read, every one the lint and the app let go on is compensable there, and the line alone decides nothing", () => {
  const t = loadAskTable()!;
  expect([...t.kinds.keys()].sort()).toEqual(["implementation-choice", "task-order", "wording"]);
  const rows = (JSON.parse(readFileSync(REVERSIBILITY_FILE, "utf8")) as { rows: Array<{ askKind?: string; gateKind: string | null; answer: string }> }).rows;
  // a merge kind or an operation of the table is not a question kind: naming it does not let the work go on
  for (const r of rows.filter((x) => !x.askKind)) expect(proceedRefusal(ask(`**進め方**: 推奨で進める（種類: ${r.gateKind ?? "promote"}）`), t)).not.toBeNull();
  for (const [kind, answer] of t.kinds) {
    expect(answer).toBe("compensable");
    expect(askProceed(ask(`**進め方**: 推奨で進める（種類: ${kind}）`, kind === "task-order" ? "#21 と #22 の順序" : "`src/names.ts` の話"), TASK)).toBe("recommended");
  }
  expect(askProceed(ask("**進め方**: 推奨で進める"))).toBe("wait");
  expect(askProceed(ask("**進め方**: 止めて待つ — 理由"))).toBe("wait");
  expect(askProceed(ask(""))).toBeNull();
});

test("a table out of its shape is not read at all (nothing goes on): no file, not JSON, no stop words, a kind in a wrong form, without an answer, or listed twice", () => {
  const write = (name: string, text: string) => {
    const f = join(W, name);
    writeFileSync(f, text);
    return f;
  };
  const row = (askKind: unknown, answer: unknown = "compensable") => ({ op: "x", gateKind: null, askKind, effect: "repository", answer });
  expect(loadAskTable(join(W, "none.json"))).toBeNull();
  expect(loadAskTable(write("a.json", "{"))).toBeNull();
  expect(loadAskTable(write("b.json", JSON.stringify({ v: 1, rows: [row("a")] })))).toBeNull();
  expect(loadAskTable(write("c.json", JSON.stringify({ v: 1, rows: [row("a")], askStops: [] })))).toBeNull();
  expect(loadAskTable(write("d.json", JSON.stringify({ v: 1, rows: [row("Not A Kind")], askStops: ["x"] })))).toBeNull();
  expect(loadAskTable(write("e.json", JSON.stringify({ v: 1, rows: [row("a", null)], askStops: ["x"] })))).toBeNull();
  expect(loadAskTable(write("f.json", JSON.stringify({ v: 1, rows: [row("a"), row("a", "irreversible")], askStops: ["x"] })))).toBeNull();
  expect(loadAskTable(write("g.json", JSON.stringify({ v: 2, rows: [row("a")], askStops: ["x"] })))).toBeNull();
  expect(loadAskTable(write("h.json", JSON.stringify({ v: 1, rows: [row("a")], askStops: ["X"] })))).toEqual({ kinds: new Map([["a", "compensable"]]), stops: ["x"] });
});
