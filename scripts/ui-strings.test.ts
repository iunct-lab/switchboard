import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUiStrings, judge, langOf } from "./ui-strings";
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
    "screen.ts": `export function screenLabel(v) { return { home: "Home", settings: "設定", approvals: "判断待ち" }[v.name]; }`,
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

  test("English body text is a violation, Japanese with a proper noun mixed in is ok", () => {
    expect(find("Context footprint")[0]).toMatchObject({ kind: "text", lang: "en", verdict: "violation" });
    expect(find("Running · Waiting")[0]).toMatchObject({ kind: "rail", lang: "en", verdict: "ok" });
    expect(find("Tasks")).toEqual([]); // only in a test file
    expect(find("Workspaces")[0]).toMatchObject({ kind: "attr", verdict: "violation" });
    expect(find("Terminal の履歴（Claude Code）")[0]).toMatchObject({ lang: "mixed", verdict: "ok" });
  });

  test("attributes are wording; a format example is data", () => {
    expect(find("owner/name#12")).toHaveLength(1);
    expect(find("owner/name#12")[0]).toMatchObject({ kind: "attr", verdict: "ok" });
  });

  test("code, compared values and value lists are not collected; the branches of a ternary are", () => {
    expect(find("bun run dev")).toEqual([]);
    expect(find("running")).toEqual([]);
    expect(find("claude")).toEqual([]);
    expect(find("実行中")[0]).toMatchObject({ kind: "literal", verdict: "ok" });
    expect(find("待ち")).toHaveLength(1);
  });

  test("a tab's word outside the header and outside a heading is a violation", () => {
    expect(find("Settings")[0]).toMatchObject({ kind: "text", verdict: "violation" });
  });

  test("a block-bodied callback inside JSX is read like the JSX around it", () => {
    expect(find("要ログイン")[0]).toMatchObject({ kind: "text", verdict: "ok" });
    expect(find("Retry")[0]).toMatchObject({ kind: "text", verdict: "violation" });
    expect(find("ログインしていません")[0]).toMatchObject({ kind: "literal", verdict: "ok" });
  });

  test("a template literal's interpolations are read for wording of their own", () => {
    expect(find("…… Terminal で実行（取り込み）")).toEqual([]);
    expect(find("Terminal で実行（取り込み）")[0]).toMatchObject({ kind: "literal", verdict: "ok" });
  });

  test("--check prints the violations only and exits 1; 0 when there is none", () => {
    const run = (d: string) => spawnSync("bun", [join(import.meta.dir, "ui-strings.ts"), "--check", d], { cwd: d, encoding: "utf8" });
    const bad = run(dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("App.tsx:");
    expect(bad.stdout).toContain("\tviolation\t設定");
    expect(bad.stdout).not.toContain("\tok\t");
    const clean = tree({ "Ok.tsx": `export const Ok = () => <header className="chrome"><button>Home</button></header>;` });
    expect(run(clean).status).toBe(0);
  });

  test("test files are skipped", () => {
    expect(all.some((s) => s.file.includes(".test."))).toBe(false);
    expect(find("Tasks")).toEqual([]);
  });

  test("screen.ts: a screen with a tab is named like the tab; approvals keeps the rail's name", () => {
    const screen = all.filter((s) => s.file === "screen.ts");
    expect(screen.map((s) => [s.text, s.kind, s.verdict])).toEqual([
      ["Home", "nav", "ok"],
      ["設定", "nav", "violation"],
      ["判断待ち", "literal", "ok"],
    ]);
  });

  test("lang and judge", () => {
    expect([langOf("設定"), langOf("Home"), langOf("Inbox に保存"), langOf("· —")]).toEqual(["ja", "en", "mixed", "symbol"]);
    expect(judge({ kind: "text", text: "3 s", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "text", text: "k", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "text", text: "Plan A", lang: "en" }).verdict).toBe("violation");
    expect(judge({ kind: "text", text: "Inbox", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "text", text: "GitHub Actions", lang: "en" }).verdict).toBe("ok");
    expect(judge({ kind: "nav", text: "·", lang: "symbol" }).verdict).toBe("ok");
  });
});
