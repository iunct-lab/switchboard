// test-reads: ops-kit/processes/p0-pipeline.md ops-kit/processes/p1-direct.md ops-kit/processes/p2-baseline.md ops-kit/processes/p3-bundle.md
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseProcess } from "./backlog-item.ts";
import { listProcesses, loadProcess, parseProcessDef, renderEntry, PROCESS_SOURCE } from "./process-defs.ts";

const P0_ENTRIES = ["to-pbi", "to-tasks", "to-tasks-ready", "complete", "complete-other", "complete-resume", "check", "close"];

test("the kit's candidates are read: p0-pipeline has the 8 stage entries, p1-direct one", () => {
  const defs = listProcesses();
  expect(defs.map((d) => d.id)).toEqual(expect.arrayContaining(["p0-pipeline", "p1-direct"]));
  const p0 = loadProcess("p0-pipeline");
  expect(p0.version).toBe(1);
  expect(p0.fits.length).toBeGreaterThan(0);
  expect(Object.keys(p0.entries).sort()).toEqual([...P0_ENTRIES].sort());
  expect(Object.keys(loadProcess("p1-direct").entries)).toEqual(["direct"]);
});

test("p1-direct's entry makes no PBI or Task Issue and leaves one line on the request", () => {
  const text = renderEntry(loadProcess("p1-direct"), "direct", { signal: "#1", reviewer: "別のランナー" });
  expect(text).toContain("PBI・Task Issue は作らない");
  expect(text).toContain("`直行: PR #<番号>`");
});

test("p1-direct's entry carries the work through review and merge, closes the request, and has a way back", () => {
  const text = renderEntry(loadProcess("p1-direct"), "direct", { signal: "#1", reviewer: "別のランナー" });
  expect(text).toContain("cross-runner-review");
  expect(text).toContain("merge-gate.ts <PR> --merge");
  // review is left to the merge-gate verdict: it runs the gate first and reviews only when the reason says 主レビュー
  expect(text).toContain("`bun scripts/merge-gate.ts <PR>`（`--merge` なし）");
  expect(text).toContain("理由に「主レビュー」が出たときだけ");
  expect(text).toContain("要否を自分で決めない");
  // skipping the review does not skip CI, and a gate that cannot judge stops the work instead of reading as "no review"
  expect(text).toContain("レビューを通さないときも CI は要る");
  expect(text).toContain("exit 2（判定できない）なら");
  expect(loadProcess("p1-direct").version).toBe(2);
  expect(text).toContain("--state closed");
  expect(text).toContain("--add-label direct-returned");
  expect(text).toContain("`直行から戻す: <理由>`");
  // a request touching an invariant goes back the same way, never just stops (without the label it is left for good)
  expect(text).toContain("触れるなら次の行のとおり戻す");
  expect(text).not.toContain("作らずに止め、理由を返答に書く");
});

test("p2-baseline: one entry that takes the concept as data, plans in docs/concept.md instead of Issues, and keeps the review, the merge gate and the invariants", () => {
  const def = loadProcess("p2-baseline");
  expect(Object.keys(def.entries)).toEqual(["baseline"]);
  const text = renderEntry(def, "baseline", { concept: "````text\n旅行の予定を同行者と共有する\n````", reviewer: "別のランナー" });
  expect(text).not.toContain("{{");
  expect(text).toContain("旅行の予定を同行者と共有する");
  expect(text).toContain("要望・PBI・Task の Issue は作らない");
  expect(text).toContain("`docs/concept.md`");
  expect(text).toContain("cross-runner-review");
  expect(text).toContain("マージ判定 `scripts/merge-gate.ts` が merge を返したときだけ");
  expect(text).toContain("`--repo <このリポジトリの owner/name>`");
  expect(text).toContain("自分の確認だけでマージしない");
  // a resume looks at the open pull requests first and does not make a second one for the same step
  expect(text).toContain("開いている `sb/baseline-*` の PR");
  // it builds only up to the graduation's phase, files the rest as requests only (no PBI), and does not graduate twice
  expect(text).toContain("`## 卒業の条件` の Phase までの行に、チェックの無い行があるとき");
  expect(text).toContain("PBI にはしない");
  // the concept merges with the skeleton while there are no CI steps to pass
  expect(text).toContain("骨組み）のコミットをその PR の枝に足して、1 本の PR としてマージする");
  expect(text).toContain("`卒業:` の行が既にあれば、何もせずに終える");
  // pressed again after the graduation: the reply says so and sends the new concept text to the usual flow
  expect(text).toContain("卒業済みで以後は要望から進めること");
  expect(text).toContain("押し直しで渡された構想の文があれば `.claude/skills/request-to-backlog/SKILL.md` で要望にする");
  // the merge's arguments, the release tag's place and no stacking without GitHub are in the entry
  expect(text).toContain("積んだ PR の最下段は `--merge-stack`");
  expect(text).toContain("利用者が認めたら `--allow-large`");
  expect(text).toContain("タグはロードマップのその行に `（PR #<番号>、<タグ>）` と書く");
  expect(text).toContain("GitHub を使わないリポジトリでは積まず、マージしてから次の項目の枝を切る");
  // a question added in the middle of the roadmap holds only the items it concerns, and its answer is a small pull request
  expect(text).toContain("その問いに関わらないロードマップの項目は先に進め");
  expect(text).toContain("その行と答えで変わる節だけを直す小さな PR で残す");
  // the definition promises the rules for that repository after the entry: the entry leaves the merge gate's place to them
  expect(readFileSync(def.path, "utf8")).toContain("読み替えを付けない開始でこの入口を始めない");
  expect(text).toContain("ops-kit/invariants.md");
  // the four steps, resumed from the document's state
  for (const step of ["**構想の文書**", "**答え**", "**ロードマップ**", "**卒業**"]) expect(text).toContain(step);
  // a concept is required: rendering without it is refused, not sent with a literal hole
  expect(() => renderEntry(def, "baseline", {})).toThrow("uses {{concept}}, which was not given");
});

test("p2-baseline is never chosen by the backlog's automatic processing, whatever the request", () => {
  const kit = listProcesses();
  expect(kit.map((d) => d.id)).toContain("p2-baseline");
  expect(loadProcess("p2-baseline").auto).toBeNull();
  const request = (bodyChars: number, labels: string[] = ["type:request"]) => ({ bodyChars, requestChars: bodyChars, labels });
  for (const item of [request(100), request(5000), request(100, ["type:request", "flow-improvement"]), request(100, ["direct-returned"])]) {
    expect(chooseProcess(item, kit).process).not.toBe("p2-baseline");
  }
});

test("p3-bundle: loads without auto and renders the bundle entry", () => {
  const def = loadProcess("p3-bundle");
  expect(def.auto).toBeNull();
  expect(Object.keys(def.entries)).toEqual(["bundle"]);
  const text = renderEntry(def, "bundle", { pbis: "#1, #2", reviewer: "レビュアーの印" });
  expect(text).not.toContain("{{");
  expect(text).toContain("#1, #2");
  expect(text).toContain("レビュアーの印");
  for (const step of ["集める", "切る", "入れる", "合わせる", "攻める", "入れ切る", "確かめる"]) expect(text).toContain(`**${step}**`);
  // a bundle needs the PBIs: rendering without them is refused, not sent with a literal hole
  expect(() => renderEntry(def, "bundle", { reviewer: "別のランナー" })).toThrow("uses {{pbis}}, which was not given");
});

test("a definition without id, version or title is refused with the path and the reason", () => {
  expect(() => parseProcessDef("---\nversion: 1\ntitle: t\n---\n", "x.md")).toThrow("x.md: frontmatter needs `id`");
  expect(() => parseProcessDef("---\nid: a\ntitle: t\n---\n", "x.md")).toThrow("needs an integer `version`");
  expect(() => parseProcessDef("---\nid: a\nversion: 1\n---\n", "x.md")).toThrow("needs `title`");
  expect(() => parseProcessDef("no frontmatter", "x.md")).toThrow("no frontmatter");
  expect(() => parseProcessDef("---\n---\n## entry e\nx\n", "x.md")).toThrow("must be a mapping");
  // only a fence on its own line closes the block: a value ending in --- is not cut
  expect(parseProcessDef("---\nid: a\nversion: 1\ntitle: t ---\n---\n## entry e\nx\n", "x.md").title).toBe("t ---");
  // a `---` rule inside the prose is not frontmatter: the block must open the file
  expect(() => parseProcessDef("# title\nprose\n---\nid: a\nversion: 1\ntitle: t\n---\n", "x.md")).toThrow("no frontmatter");
  expect(() => parseProcessDef("---\nid: a\nversion: 1\ntitle: t\n---\n## entry e\na\n## entry e\nb\n", "x.md")).toThrow("appears twice");
});

test("renderEntry fills {{keys}} and refuses a key that was not given or an entry that does not exist", () => {
  const def = parseProcessDef("---\nid: a\nversion: 2\ntitle: t\nfits:\n  - small\n---\nprose before entries\n\n## entry go\n\nDo #{{n}} with {{count}} items.\n\ntrailing\n\n## entry stop\nStop.\n", "a.md");
  expect(def.fits).toEqual(["small"]);
  expect(renderEntry(def, "go", { n: 7, count: "two" })).toBe("Do #7 with two items.\n\ntrailing");
  expect(renderEntry(def, "stop", {})).toBe("Stop.");
  expect(() => renderEntry(def, "go", { n: 7 })).toThrow("uses {{count}}, which was not given");
  expect(() => renderEntry(def, "nope", {})).toThrow("no `## entry nope`");
});

test("listProcesses / loadProcess read a root's ops-kit/processes and refuse an id that differs from the file name", () => {
  const root = mkdtempSync(join(tmpdir(), "switchboard-procs-"));
  try {
    expect(listProcesses(root)).toEqual([]);
    mkdirSync(join(root, PROCESS_SOURCE), { recursive: true });
    writeFileSync(join(root, PROCESS_SOURCE, "b.md"), "---\nid: b\nversion: 1\ntitle: B\n---\n## entry e\nx\n");
    writeFileSync(join(root, PROCESS_SOURCE, "README.md"), "# not a candidate\n");
    expect(listProcesses(root).map((d) => d.id)).toEqual(["b"]);
    expect(() => loadProcess("missing", root)).toThrow("process `missing` not found");
    expect(() => loadProcess("../etc", root)).toThrow("is not a file name");
    writeFileSync(join(root, PROCESS_SOURCE, "c.md"), "---\nid: other\nversion: 1\ntitle: C\n---\n");
    expect(() => loadProcess("c", root)).toThrow("must equal the file name");
    expect(() => listProcesses(root)).toThrow("must equal the file name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`auto` is read as the criteria, null when absent, and a wrong type throws with the path", () => {
  const def = (auto: string) => parseProcessDef(`---\nid: a\nversion: 1\ntitle: t\n${auto}---\n`, "x.md");
  expect(def("").auto).toBeNull();
  expect(def("auto: { maxBodyChars: 600, excludeLabels: [on-hold] }\n").auto).toEqual({ maxBodyChars: 600, excludeLabels: ["on-hold"] });
  expect(def("auto: {}\n").auto).toEqual({});
  expect(loadProcess("p1-direct").auto).toEqual({ maxBodyChars: 600, excludeLabels: ["needs-decision", "on-hold", "flow-improvement"] });
  expect(loadProcess("p0-pipeline").auto).toBeNull();
  expect(() => def("auto: yes\n")).toThrow("x.md: `auto` must be a mapping");
  expect(() => def("auto: { maxBodyChars: many }\n")).toThrow("x.md: `auto.maxBodyChars` must be an integer");
  expect(() => def("auto: { excludeLabels: on-hold }\n")).toThrow("x.md: `auto.excludeLabels` must be a list of strings");
});

test("renderEntry keeps only the condition blocks that match, and refuses a condition it was not given", () => {
  const def = parseProcessDef(["---", "id: demo", "version: 1", "title: demo", "fits:", "  - x", "---", "", "## entry go", "", "始める {{n}}", "<!-- when review=same -->", "同じランナーに頼む", "<!-- end when -->", "<!-- when review=other -->", "別のランナーに頼む", "<!-- end when -->", ""].join("\n"), "demo.md");
  expect(renderEntry(def, "go", { n: 1 }, { review: "same" })).toBe("始める 1\n同じランナーに頼む");
  expect(renderEntry(def, "go", { n: 1 }, { review: "other" })).toBe("始める 1\n別のランナーに頼む");
  expect(() => renderEntry(def, "go", { n: 1 })).toThrow("条件 review の値が渡されていない");
});
