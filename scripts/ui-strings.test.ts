// test-reads: scripts/ui-strings.ts apps/web/src/
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUiStrings, judge, langOf, markedValues } from "./ui-strings";
import { spawnSync } from "node:child_process";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-strings."));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const APP = `export function App() {
  return (
    <div>
      <header className="chrome">
        <span className="brand">Switchboard</span>
        <nav className="tabs"><button>Home</button><button>設定</button></nav>
        <span className="conn">{ok ? "daemon connected" : "daemon offline"}</span>
      </header>
      <h5>Backlog</h5>
      <h5>Task Brief</h5>
      <h5>Workspace MCP</h5>
      <div className="grp">Running · Waiting</div>
      <div>Context footprint</div>
      <p>Terminal の履歴（Claude Code）</p>
      <input placeholder="owner/name#12" title="Workspaces" />
      <code>bun run dev</code>
      {status === "running" ? "実行中" : "待ち"}
      {(["claude", "codex"]).map((r) => <span key={r}>{r}</span>)}
      {rows.map((r) => {
        const off = r.ok ? "" : "ログインしていません";
        return <label key={r.id} title={off}><span className="hint">要ログイン</span><button>Retry</button></label>;
      })}
      <button title={\`\${t.cwd}\${t.local ? "\\nTerminal で実行（取り込み）" : ""}\`}>Settings</button>
    </div>
  );
}
`;

describe("ui-strings", () => {
  const dir = tree({
    "App.tsx": APP,
    "components/Rail.test.tsx": `export const X = () => <div>Tasks</div>;`,
    "screen.ts": `export function screenLabel(v) {
  // ui-strings: value "判断待ち" — sent to the daemon
  return { home: "Home", settings: "設定", approvals: "判断待ち" }[v.name];
}`,
  });
  const all = collectUiStrings([dir], dir);
  const find = (text: string) => all.filter((s) => s.text === text);

  test("the header's Japanese tab is a violation; its English words, brand and connection state are ok", () => {
    expect(find("設定").find((s) => s.file === "App.tsx")).toMatchObject({ kind: "nav", lang: "ja", verdict: "violation" });
    for (const t of ["Switchboard", "Home", "daemon connected", "daemon offline"]) expect(find(t)[0]).toMatchObject({ kind: "nav", verdict: "ok" });
  });

  test("a heading named after a tab is ok; an English heading that is neither a tab nor a proper noun is a violation", () => {
    expect(find("Backlog")[0]).toMatchObject({ kind: "heading", verdict: "ok" });
    expect(find("Task Brief")[0]).toMatchObject({ kind: "heading", verdict: "violation" });
    expect(find("Workspace MCP")[0]).toMatchObject({ kind: "heading", verdict: "ok" });
  });

  test("English body text is a violation; so is Japanese, with or without a proper noun mixed in (untranslated)", () => {
    expect(find("Context footprint")[0]).toMatchObject({ kind: "text", lang: "en", verdict: "violation" });
    expect(find("Running · Waiting")[0]).toMatchObject({ kind: "rail", lang: "en", verdict: "ok" });
    expect(find("Tasks")).toEqual([]); // only in a test file
    expect(find("Workspaces")[0]).toMatchObject({ kind: "attr", verdict: "violation" });
    expect(find("Terminal の履歴（Claude Code）")[0]).toMatchObject({ lang: "mixed", verdict: "violation", reason: "untranslated" });
  });

  test("attributes are wording; a format example is data", () => {
    expect(find("owner/name#12")).toHaveLength(1);
    expect(find("owner/name#12")[0]).toMatchObject({ kind: "attr", verdict: "ok" });
  });

  test("code, compared values and value lists are not collected; the branches of a ternary are", () => {
    expect(find("bun run dev")).toEqual([]);
    expect(find("running")).toEqual([]);
    expect(find("claude")).toEqual([]);
    expect(find("実行中")[0]).toMatchObject({ kind: "literal", verdict: "violation", reason: "untranslated" });
    expect(find("待ち")).toHaveLength(1);
  });

  test("a tab's word outside the header and outside a heading is a violation", () => {
    expect(find("Settings")[0]).toMatchObject({ kind: "text", verdict: "violation" });
  });

  test("a block-bodied callback inside JSX is read like the JSX around it", () => {
    expect(find("要ログイン")[0]).toMatchObject({ kind: "text", verdict: "violation" });
    expect(find("Retry")[0]).toMatchObject({ kind: "text", verdict: "violation" });
    expect(find("ログインしていません")[0]).toMatchObject({ kind: "literal", verdict: "violation" });
  });

  test("a template literal's interpolations are read for wording of their own", () => {
    expect(find("…… Terminal で実行（取り込み）")).toEqual([]);
    expect(find("Terminal で実行（取り込み）")[0]).toMatchObject({ kind: "literal", verdict: "violation" });
  });

  test("--check prints the violations only and exits 1; 0 when there is none", () => {
    const run = (d: string) => spawnSync("bun", [join(import.meta.dir, "ui-strings.ts"), "--check", d], { cwd: d, encoding: "utf8" });
    const bad = run(dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("App.tsx:");
    expect(bad.stdout).toContain("\tviolation\tnav must be English words\t設定");
    expect(bad.stdout).toContain("\tviolation\tuntranslated\t実行中");
    expect(bad.stdout).not.toContain("\tok\t");
    const clean = tree({ "Ok.tsx": `export const Ok = () => <header className="chrome"><button>Home</button></header>;` });
    expect(run(clean).status).toBe(0);
  });

  test("test files are skipped", () => {
    expect(all.some((s) => s.file.includes(".test."))).toBe(false);
    expect(find("Tasks")).toEqual([]);
  });

  test("screen.ts: a screen with a tab is named like the tab; approvals keeps the rail's name, marked as a value", () => {
    const screen = all.filter((s) => s.file === "screen.ts");
    expect(screen.map((s) => [s.text, s.kind, s.verdict])).toEqual([
      ["Home", "nav", "ok"],
      ["設定", "nav", "violation"],
      ["判断待ち", "literal", "ok"],
    ]);
  });

  test("Japanese written directly is untranslated; wording through t() is not collected", () => {
    const d = tree({ "Save.tsx": `import { t } from "./i18n.ts";\nexport const Save = () => <div><p>保存</p><p>{t(m.save)}</p><p title={t(m.hint)}>{t(m.count, { n: 3 })}</p></div>;` });
    const got = collectUiStrings([d], d);
    expect(got).toEqual([{ file: "Save.tsx", line: 2, kind: "text", text: "保存", lang: "ja", verdict: "violation", reason: "untranslated" }]);
    const run = spawnSync("bun", [join(import.meta.dir, "ui-strings.ts"), "--check", d], { cwd: d, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Save.tsx:2\ttext\tja\tviolation\tuntranslated\t保存");
  });

  test("a ui-strings: value comment exempts the texts it names, in the node after it only", () => {
    expect(markedValues(`// ui-strings: value "判断待ち" "a b" — sent`)).toEqual(["判断待ち", "a b"]);
    expect(markedValues("// sent to the daemon")).toEqual([]);
    const d = tree({
      "V.tsx": `export const V = () => (
  <div>
    {/* ui-strings: value "plan" "判断待ち" — keys */}
    <p>{box("plan")}{box("判断待ち")}{box("保存")}</p>
    <p>{box("plan")}</p>
    {"error" in r ? <i>{r.error}</i> : null}
  </div>
);
export function label() {
  // ui-strings: value "要対応" — compared by the daemon
  return <b>{x ? "要対応" : "対応"}</b>;
}`,
    });
    const got = collectUiStrings([d], d).map((s) => [s.line, s.text, s.verdict, s.reason]);
    expect(got).toEqual([
      [4, "plan", "ok", "marked as a value"],
      [4, "判断待ち", "ok", "marked as a value"],
      [4, "保存", "violation", "untranslated"],
      [5, "plan", "violation", "English outside the header and the proper nouns"],
      [11, "要対応", "ok", "marked as a value"],
      [11, "対応", "violation", "untranslated"],
    ]);
  });

  test("outside JSX, Japanese in a .ts helper or a .tsx constant is untranslated; values, English and the dictionaries are not collected", () => {
    const d = tree({
      "notice.ts": `export const done = () => "保存しました";
export const status = (s: string) => (s === "完了" ? t(m.done) : \`\${s} を待っています\`);
export const key = { kind: "要望" };
export const path = "/api/tasks";
// ui-strings: value "拒否" — sent to the daemon
export const deny = "拒否";`,
      "Panel.tsx": `const HEAD = "見出し";\nexport const Panel = () => <h5>{HEAD}</h5>;`,
      "i18n/home.ts": `export const home = msgs({ save: { ja: "保存", en: "Save" } });`,
      "notice.test.ts": `test("x", () => expect(done()).toBe("保存しました"));`,
    });
    const got = collectUiStrings([d], d).map((s) => [s.file, s.line, s.kind, s.text, s.verdict, s.reason]);
    expect(got).toEqual([
      ["Panel.tsx", 1, "literal", "見出し", "violation", "untranslated"],
      ["notice.ts", 1, "literal", "保存しました", "violation", "untranslated"],
      ["notice.ts", 2, "literal", "… を待っています", "violation", "untranslated"],
      ["notice.ts", 6, "literal", "拒否", "ok", "marked as a value"],
    ]);
  });

  test("apps/web/src has no violation: Japanese added without the dictionary fails here", () => {
    const root = join(import.meta.dir, "..");
    const run = spawnSync("bun", [join(import.meta.dir, "ui-strings.ts"), "--check", "apps/web/src"], { cwd: root, encoding: "utf8" });
    expect(run.stdout).toBe("");
    expect(run.status).toBe(0);
  });

  test("lang and judge", () => {
    expect([langOf("設定"), langOf("Home"), langOf("Inbox に保存"), langOf("· —")]).toEqual(["ja", "en", "mixed", "symbol"]);
    expect(judge({ kind: "text", text: "3 s", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "text", text: "k", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "text", text: "Plan A", lang: "en" }).verdict).toBe("violation");
    expect(judge({ kind: "text", text: "Inbox", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "text", text: "GitHub Actions", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "nav", text: "·", lang: "symbol" }).verdict).toBe("ok");
    expect(judge({ kind: "heading", text: "設定", lang: "ja" })).toEqual({ verdict: "violation", reason: "untranslated" });
    expect(judge({ kind: "attr", text: "Inbox に保存", lang: "mixed" })).toEqual({ verdict: "violation", reason: "untranslated" });
  });
});
