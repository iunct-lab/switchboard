import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { fakeGh, GhError, type FakeCall } from "./gh.ts";
import { formatLint, lint, LintFetchError, speakerOf } from "./lint.ts";
import type { StoredRecords } from "./backlog-client.ts";

const fixtures = join(import.meta.dir, "../fixtures");
const configPath = join(fixtures, "config-with-phase.json");
const cfg = loadConfig(configPath);
const page = (name: string) => () => JSON.parse(readFileSync(join(fixtures, "lint", `${name}.json`), "utf8"));
const noSleep = async () => undefined;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GH_REPO;
  process.env.GH_REPO = "example/repo";
});
afterEach(() => {
  if (saved === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = saved;
});

async function lines(name: string) {
  const { violations } = await lint(fakeGh([page(name)]), cfg, { sleep: noSleep });
  return formatLint(violations);
}

describe("lint", () => {
  test("lint: ok — no violations, and one query reads the repository and the Project", async () => {
    const gh = fakeGh([page("ok")]);
    const r = await lint(gh, cfg, { sleep: noSleep });
    expect(r).toEqual({ violations: [], fetched: 3 });
    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0] as Extract<FakeCall, { kind: "graphql" }>;
    expect(call.vars).toEqual({ ro: "example", rn: "repo", after: null, o: "example", p: 1 });
    expect(call.query).toContain('labels:["type:pbi","type:task","type:request"], first:100');
    expect(call.query).toContain("repositoryOwner(login:$o){ ... on ProjectV2Owner{ projectV2(number:$p)");
    expect(formatLint(r.violations)).toEqual(["violations: 0  (api errors: 0)"]);
  });

  test("lint: missing-section — each required section from the config, and the checkbox line", async () => {
    expect(await lines("missing-section")).toEqual([
      "#10: PBI に「## スコープ外」が無い",
      "#10: PBI の受け入れ条件にチェックボックス行が無い",
      "#11: Task に「## 検証」が無い",
      "violations: 3  (api errors: 0)",
    ]);
  });

  test("lint: origin-format — `なし` without a reason, a missing section (with its hint), a blank line before the value", async () => {
    expect(await lines("origin-format")).toEqual([
      "#10: PBI の「## 元要望」は `#N（要望のどの部分か）` か `なし（理由）`（今: なし）",
      "#12: PBI に「## 元要望」が無い（要望 Issue の番号。無ければ「なし（理由）」）",
      "violations: 2  (api errors: 0)",
    ]);
  });

  test("lint: sp-mismatch — body vs Project, unset, outside the set; a `### Story Points` heading counts", async () => {
    expect(await lines("sp-mismatch")).toEqual([
      "#10: Story Points が本文（3）と Project（5）で違う",
      '#12: Project の Story Points が未設定（set 12 "Story Points" 3）',
      "#13: Project の Story Points が 1 / 2 / 3 / 5 / 8 以外（4）",
      "violations: 3  (api errors: 0)",
    ]);
  });

  test("lint: priority — a PBI without a Priority, or with one outside the config, is a violation with how to set it; a request or a Task without one is not", async () => {
    expect(await lines("priority")).toEqual([
      "#10: Project の Priority が未設定（backlog set 10 Priority <P0 / P1 / P2 / P3>）",
      "#12: Project の Priority が P0 / P1 / P2 / P3 以外（P9）",
      "violations: 2  (api errors: 0)",
    ]);
  });

  test("lint: sp-13 — too big, not in the set, missing in the body", async () => {
    expect(await lines("sp-13")).toEqual([
      "#10: Story Points 13 は「大きすぎる」の印。分割してから Backlog に入れる",
      "#10: Story Points が本文（13）と Project（8）で違う",
      "#12: Story Points は 1 / 2 / 3 / 5 / 8 のどれか（本文: 4）",
      "#12: Project の Story Points が 1 / 2 / 3 / 5 / 8 以外（4）",
      "#13: PBI 本文に `**Story Points**: N` が無い",
      "violations: 5  (api errors: 0)",
    ]);
  });

  test("lint: no-parent — a Task without a parent or with a non-PBI parent; a PBI with a parent", async () => {
    expect(await lines("no-parent")).toEqual([
      "#10: PBI に親 Issue（#2）が付いている。PBI は親なし（Backlog ビューに出すため）",
      "#11: Task に親 PBI（sub-issue の親）が付いていない",
      "#12: Task の親 #1 が type:pbi ではない",
      "violations: 3  (api errors: 0)",
    ]);
  });

  test("lint: ready-without-tasks — Ready / In progress need a Task; a PBI outside the Project", async () => {
    expect(await lines("ready-without-tasks")).toEqual([
      "#10: Status=Ready なのに Task（sub-issue）が無い",
      "#12: Status=In progress なのに Task（sub-issue）が無い",
      "#14: Project に入っていない（triage で追加する）",
      "violations: 3  (api errors: 0)",
    ]);
  });

  test("lint: request-missing-source — the request's sections, with their hints", async () => {
    expect(await lines("request-missing-source")).toEqual([
      "#1: 要望に「## 出典」が無い（誰の言葉 / いつ / 経路）",
      "#2: 要望に「## 要望」が無い（意図を変えずに整えた文を入れる）",
      "#2: 要望に「## 出典」が無い（誰の言葉 / いつ / 経路）",
      "violations: 3  (api errors: 0)",
    ]);
  });

  test("requests: a 出典 without 誰の言葉, or with another value, is a violation (誰の言葉)", async () => {
    const line = "要望の「## 出典」に「- 誰の言葉: 利用者 / エージェント / 定期の検査」の行が無い";
    // #3 the old 誰から, #4 values other than the three, #5 the line outside 出典; #6 passes (a note may follow the value)
    expect(await lines("request-speaker")).toEqual([`#3: ${line}`, `#4: ${line}`, `#5: ${line}`, "violations: 3  (api errors: 0)"]);
    expect(speakerOf("## 出典\n- 誰の言葉: エージェント\n")).toBe("エージェント");
    expect(speakerOf("## 要望\nx\n")).toBeNull();
    // the Issue form writes ### headings: 出典 ends at the next heading of its level, not at the next ##
    expect(speakerOf("### 出典\n\n- いつ: y\n\n### 解釈メモ\n\n- 誰の言葉: 利用者\n")).toBeNull();
    expect(speakerOf("### 出典\n\n- 誰の言葉: 利用者\n\n### 添付\n")).toBe("利用者");
  });

  test("lint: bad-shape — no nodes, or no fieldValues, is a fetch error (exit 2), never a pass", async () => {
    await expect(lint(fakeGh([page("bad-shape")]), cfg, { sleep: noSleep })).rejects.toBeInstanceOf(LintFetchError);
    await expect(lint(fakeGh([page("bad-shape-field-values")]), cfg, { sleep: noSleep })).rejects.toThrow(/Project のフィールドが無い/);
    await expect(lint(fakeGh([() => ({ repositoryOwner: { projectV2: null }, repository: {} })]), cfg, { sleep: noSleep })).rejects.toThrow(/Project example\/1 が見つかりません/);
  });

  test("lint: pages — the second page is read with the cursor, and every Issue is checked", async () => {
    const gh = fakeGh([page("page-1"), page("page-2")]);
    const r = await lint(gh, cfg, { sleep: noSleep });
    expect(r.fetched).toBe(4);
    expect((gh.calls[1] as Extract<FakeCall, { kind: "graphql" }>).vars.after).toBe("CURSOR1");
    expect(formatLint(r.violations)).toEqual(["#20: Story Points が本文（3）と Project（5）で違う", "violations: 1  (api errors: 0)"]);
  });

  test("lint: retries — a failing query is tried 3 times, then it is a fetch error", async () => {
    const waits: number[] = [];
    const fail = () => {
      throw new Error("secondary rate limit");
    };
    const ok = await lint(fakeGh([fail, page("ok")]), cfg, { sleep: async (ms) => void waits.push(ms) });
    expect(ok.violations).toEqual([]);
    await expect(lint(fakeGh([fail, fail, fail]), cfg, { sleep: async (ms) => void waits.push(ms) })).rejects.toThrow(/open の Issue の取得に失敗: secondary rate limit/);
    expect(waits).toEqual([2000, 2000, 4000]);
    // a limit or an auth failure the client classified is not asked again (#894)
    for (const kind of ["secondary", "auth"] as const) {
      const gh = fakeGh([() => { throw new GhError(kind, kind); }]);
      await expect(lint(gh, cfg, { sleep: async (ms) => void waits.push(ms) })).rejects.toThrow(LintFetchError);
      expect(gh.calls).toHaveLength(1);
    }
    expect(waits).toEqual([2000, 2000, 4000]);
  });

  test("lint: --no-project — no Project in the query, no Project checks", async () => {
    const gh = fakeGh([page("sp-mismatch")]);
    const r = await lint(gh, cfg, { withProject: false, sleep: noSleep });
    expect(r.violations).toEqual([]);
    const call = gh.calls[0] as Extract<FakeCall, { kind: "graphql" }>;
    expect(call.query).not.toContain("projectItems");
    expect(call.vars).toEqual({ ro: "example", rn: "repo", after: null });
  });

  test("lint: CRLF bodies read like LF ones", async () => {
    const crlf = () => {
      const d = page("ok")();
      for (const n of d.repository.issues.nodes) n.body = n.body.replace(/\n/g, "\r\n");
      return d;
    };
    expect((await lint(fakeGh([crlf]), cfg, { sleep: noSleep })).violations).toEqual([]);
  });

  test("lint: a missing origin section comes after the checkbox line, and is required even when sections.pbi does not list it", async () => {
    const body = "## ユーザーストーリー\nx\n\n## 到達点 / 受け入れ条件\n条件\n\n## スコープ外\n- なし\n\n**Story Points**: 3\n";
    const one = () => ({ ...page("ok")(), repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...page("ok")().repository.issues.nodes[0], body }] } } });
    expect(formatLint((await lint(fakeGh([one]), cfg, { sleep: noSleep })).violations)).toEqual([
      "#10: PBI の受け入れ条件にチェックボックス行が無い",
      "#10: PBI に「## 元要望」が無い（要望 Issue の番号。無ければ「なし（理由）」）",
      "violations: 2  (api errors: 0)",
    ]);
    const unlisted = { ...cfg, sections: { ...cfg.sections, pbi: cfg.sections.pbi.filter((s) => typeof s === "string") } };
    expect(formatLint((await lint(fakeGh([one]), unlisted, { sleep: noSleep })).violations)).toContain("#10: PBI に「## 元要望」が無い");
  });

  test("lint: the origin format comes from the config", async () => {
    const other = { ...cfg, sections: { ...cfg.sections, origin: { name: "元要望", pattern: "^Request #[0-9]+$", hint: "`Request #N`" } } };
    expect(formatLint((await lint(fakeGh([page("ok")]), other, { sleep: noSleep })).violations)).toEqual([
      "#10: PBI の「## 元要望」は `Request #N`（今: #1（要望の一文））",
      "violations: 1  (api errors: 0)",
    ]);
  });

  test("lint: the @me owner reads the viewer's Project; a config without an origin section does not check one", async () => {
    const gh = fakeGh([() => ({ ...page("ok")(), repositoryOwner: undefined, viewer: { projectV2: { id: "P1" } } })]);
    expect((await lint(gh, { ...cfg, owner: "@me" }, { sleep: noSleep })).violations).toEqual([]);
    const call = gh.calls[0] as Extract<FakeCall, { kind: "graphql" }>;
    expect(call.query).toContain("viewer{ projectV2(number:$p)");
    expect(call.query).not.toContain("$o:");
    expect(call.vars).toEqual({ ro: "example", rn: "repo", after: null, p: 1 });
    const noPhase = loadConfig(join(fixtures, "config-no-phase.json"));
    const r = await lint(fakeGh([page("origin-format")]), noPhase, { withProject: false, sleep: noSleep });
    expect(r.violations.some((v) => v.message.includes("元要望"))).toBe(false);
  });

  test("lint: the CLI prints the lines and exits 0 / 1 / 2", async () => {
    const run = async (responses: Parameters<typeof fakeGh>[0], extra: string[] = []) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["lint", "--config", configPath, ...extra], fakeGh(responses), (s) => out.push(s), (s) => err.push(s), noSleep, { ...process.env, BACKLOG_URL: undefined });
      return { code, out, err };
    };
    expect(await run([page("ok")])).toEqual({ code: 0, out: ["violations: 0  (api errors: 0)"], err: [] });
    expect((await run([page("no-parent")])).code).toBe(1);
    expect((await run([page("bad-shape")])).code).toBe(2);
    expect((await run([], ["--bogus"])).code).toBe(2);
    const missing = await main(["lint", "--config", "/nonexistent/ops.config.json"], fakeGh([]), () => undefined, () => undefined, noSleep, { ...process.env, BACKLOG_URL: undefined });
    expect(missing).toBe(2);
  });

  /** The page GitHub answered, as the app would have stored it (#919): parents not in the page are stored with their labels. */
  const recordsOf = (name: string): StoredRecords => {
    const nodes = page(name)().repository.issues.nodes as any[];
    const issue = (n: number, labels: string[], over: Partial<StoredRecords["issues"][number]> = {}): StoredRecords["issues"][number] => ({ number: n, title: "", state: "OPEN", stateReason: null, body: "", labels, parent: null, subIssues: [], updatedAt: "", fields: null, ...over });
    const issues = nodes.map((r) => {
      const item = r.projectItems.nodes.find((i: any) => i.project.number === 1);
      const fields = item ? Object.fromEntries(item.fieldValues.nodes.filter((v: any) => v.field).map((v: any) => [v.field.name, v.number ?? v.name])) : null;
      return issue(r.number, r.labels.nodes.map((l: any) => l.name), { body: r.body, parent: r.parent?.number ?? null, subIssues: Array.from({ length: r.subIssues.totalCount }, (_, k) => 1000 + k), fields });
    });
    const parents = nodes.flatMap((r) => (r.parent && !nodes.some((o) => o.number === r.parent.number) ? [issue(r.parent.number, r.parent.labels.nodes.map((l: any) => l.name), { state: "CLOSED" })] : []));
    return { workspaceId: "w", service: "github", repository: "example/repo", project: { owner: "example", number: 1 }, fetchedAt: 1, top: [], issues: [...issues, ...parents, issue(99, ["type:pbi"], { state: "CLOSED" })], unread: [], pulls: [] };
  };

  test("lint from the app's stored records (#919): the same violations as GitHub's answer, without asking GitHub", async () => {
    for (const name of ["ok", "no-parent", "sp-mismatch", "sp-13", "ready-without-tasks", "request-missing-source", "request-speaker", "missing-section", "priority"]) {
      const gh = fakeGh([]);
      const stored = await lint(gh, cfg, { records: recordsOf(name), sleep: noSleep });
      expect(stored, name).toEqual(await lint(fakeGh([page(name)]), cfg, { sleep: noSleep }));
      expect(gh.calls, name).toHaveLength(0);
    }
    expect((await lint(fakeGh([]), cfg, { records: recordsOf("ready-without-tasks"), withProject: false })).violations).toEqual((await lint(fakeGh([page("ready-without-tasks")]), cfg, { withProject: false, sleep: noSleep })).violations);
  });

  test("lint from stored records: an open Issue the last import did not read is a fetch error (exit 2), never a pass", async () => {
    const r = recordsOf("ok");
    await expect(lint(fakeGh([]), cfg, { records: { ...r, unread: [r.issues[0]!.number] } })).rejects.toThrow(LintFetchError);
    // a closed one is not checked, so it does not stop the check
    expect((await lint(fakeGh([]), cfg, { records: { ...r, unread: [99] } })).violations).toEqual([]);
  });
});
