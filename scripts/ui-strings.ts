/**
 * bun scripts/ui-strings.ts [--check] [dir…] — the fixed strings the web UI shows, each judged against the language rule
 * of docs/design/ui-language.md. Without --check every string is printed; with it only the violations, exit 1 if any.
 * The rule's data (NAV_EN, RAIL_HEADINGS, PROPER_NOUNS) lives here only; the design doc points at it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type UiString = {
  file: string;
  line: number;
  kind: "nav" | "heading" | "rail" | "text" | "attr" | "literal";
  text: string;
  lang: "ja" | "en" | "mixed" | "symbol";
  verdict: "ok" | "violation";
  reason: string;
};

/** The header's words: the tabs, the rescue entry and the brand. A screen named after a tab uses the same word. */
export const NAV_EN = ["Switchboard", "Home", "Task", "Knowledge", "Ledger", "Insights", "Backlog", "Schedules", "Settings", "Rescue", "daemon connected", "daemon offline"];

/** Names kept as they are inside any string: products, runners, external services, protocols and units. Longest first when matched. */
export const PROPER_NOUNS = [
  "Switchboard", "Claude Code", "Claude", "Codex", "DAK", "GitHub", "GitHub Actions", "Actions", "Project", "Issue", "PR", "Milestone",
  "MCP", "Workspace MCP", "CLI", "API", "URL", "JSON", "SSE", "CDP", "SQLite", "Bun", "AWS", "EC2", "S3", "CloudFront", "SSO",
  "LLM", "VS Code", "Cursor", "FTS5", "Git", "git", "CPU", "PNG", "HTML", "CSS", "Markdown",
  // the app's own concepts and units, kept in English by the owner's answer (2026-10-23)
  "Workspace", "Inbox", "Terminal", "Task", "SP", "PBI", "worktree", "main", "OK", "ID", "id", "ms", "KB", "MB", "GB", "JST", "UTC",
];

/** The rail's group headings stay as they are (the owner's answer, 2026-10-23): English ones are ok as written. */
export const RAIL_HEADINGS = ["Running · Waiting", "Tasks"];

const ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label"]);
/** Children of these are code, paths or commands the user copies: data, not wording. */
const VERBATIM = new Set(["code", "pre", "kbd"]);
/** Object keys whose string value is shown as it is; any other key's value inside JSX is data (`{ period: "now" }`). */
const LABEL_KEYS = new Set(["label", "title", "text", "placeholder", "hint", "message"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const JA = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LATIN = /[A-Za-z]/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Paths, env names, ids, placeholders and format examples (`~/.claude`, `SB_X`, `{{target}}`, `type:pbi`, `#12`): data, not words. */
const CODE_TOKEN = /[^\s（）()「」、。]*([_/~{}#]|\w[:.]\w)[^\s（）()「」、。]*/g;
const NAMES = new RegExp(`(?<![A-Za-z])(${[...PROPER_NOUNS].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![A-Za-z])`, "g");

export function langOf(text: string): UiString["lang"] {
  const ja = JA.test(text);
  const en = LATIN.test(text);
  return ja && en ? "mixed" : ja ? "ja" : en ? "en" : "symbol";
}

export function judge(s: Pick<UiString, "kind" | "text" | "lang">): Pick<UiString, "verdict" | "reason"> {
  if (s.kind === "nav") return s.lang === "en" || s.lang === "symbol" ? { verdict: "ok", reason: "nav is English" } : { verdict: "violation", reason: "nav must be English words" };
  if (s.lang !== "en") return { verdict: "ok", reason: s.lang === "symbol" ? "no words" : "Japanese (names may be mixed in)" };
  if (s.kind === "heading" && NAV_EN.includes(s.text)) return { verdict: "ok", reason: "screen named after its tab" };
  if (s.kind === "rail" && RAIL_HEADINGS.includes(s.text)) return { verdict: "ok", reason: "the rail's heading, kept as it is" };
  // a single letter next to a number is a unit or a metric (`3 s`, `12 k`, `p90`); a letter alone follows a `{number}`
  const left = s.text.replace(CODE_TOKEN, "").replace(NAMES, "").replace(/(?<=\d ?)[A-Za-z](?![A-Za-z])|(?<![A-Za-z])[A-Za-z](?=\d)|^[A-Za-z]$/g, "");
  return LATIN.test(left) ? { verdict: "violation", reason: "English outside the header and the proper nouns" } : { verdict: "ok", reason: "proper nouns only" };
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (!/\.test\.[jt]sx?$/.test(name) && (name.endsWith(".tsx") || name === "screen.ts")) out.push(p);
  }
  return out;
}

const tagOf = (n: ts.Node): string | undefined =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : undefined;

const attrsOf = (n: ts.Node): ts.JsxAttributes | undefined =>
  ts.isJsxElement(n) ? n.openingElement.attributes : ts.isJsxSelfClosingElement(n) ? n.attributes : undefined;

const hasClass = (n: ts.Node, name: string): boolean =>
  !!attrsOf(n)?.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "className" && p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text.split(/\s+/).includes(name));

/** `<header className="chrome">`: the app's header, whose words are nav. */
const isChrome = (n: ts.Node): boolean => tagOf(n) === "header" && hasClass(n, "chrome");

/** A template literal's words with each `${…}` as "…" (the value is data). */
function literalText(n: ts.Node): string | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => `…${s.literal.text}`).join("");
  return undefined;
}

/** A literal compared with ===, used as a key or as an argument of a non-display call is a value, not wording. */
function isValueUse(n: ts.Node): boolean {
  const p = n.parent;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
  if (ts.isCaseClause(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isPropertyAssignment(p)) return p.name === n || !LABEL_KEYS.has(p.name.getText());
  // a list of plain strings (`["claude", "codex"].map(…)`) is a list of values; a row like `["LLM", x]` is wording
  if (ts.isArrayLiteralExpression(p) && p.elements.every((e) => literalText(e) !== undefined)) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
    const callee = p.expression.getText();
    return /(^|\.)(includes|startsWith|endsWith|split|join|replace|get|has|set|indexOf|querySelector|getElementById|addEventListener|fetch|localStorage\.\w+)$/.test(callee) || /^(api|get|post|put|del|send)$/.test(callee);
  }
  return false;
}

export function collectFile(path: string, root = process.cwd()): UiString[] {
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const file = relative(root, path);
  const out: UiString[] = [];
  const add = (node: ts.Node, kind: UiString["kind"], raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    const lang = langOf(text);
    out.push({ file, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, kind, text, lang, ...judge({ kind, text, lang }) });
  };

  // screen.ts: the names the feedback dialog gives each screen. A screen with a tab is named like the tab;
  // approvals has no tab (the rail's 判断待ち opens it) and keeps that name.
  if (path.endsWith("screen.ts")) {
    const visit = (n: ts.Node, inLabel: boolean): void => {
      const here = inLabel || (ts.isFunctionDeclaration(n) && n.name?.text === "screenLabel");
      if (here && ts.isPropertyAssignment(n)) {
        const t = literalText(n.initializer);
        if (t !== undefined) add(n.initializer, n.name.getText() === "approvals" ? "literal" : "nav", t);
        return;
      }
      ts.forEachChild(n, (c) => visit(c, here));
    };
    visit(src, false);
    return out;
  }

  type Ctx = { nav: boolean; heading: boolean; rail: boolean; verbatim: boolean; inJsx: boolean };
  const visit = (n: ts.Node, ctx: Ctx): void => {
    const tag = tagOf(n);
    if (tag) {
      const next = { nav: ctx.nav || isChrome(n), heading: HEADINGS.has(tag), rail: hasClass(n, "grp"), verbatim: ctx.verbatim || VERBATIM.has(tag), inJsx: true };
      for (const p of attrsOf(n)!.properties) {
        if (!ts.isJsxAttribute(p) || !p.initializer || !ATTRS.has(p.name.getText())) continue;
        const init = p.initializer;
        if (ts.isStringLiteral(init)) add(init, "attr", init.text);
        else if (ts.isJsxExpression(init) && init.expression) visit(init.expression, { ...next, nav: false, heading: false, rail: false });
      }
      if (ts.isJsxElement(n)) for (const c of n.children) visit(c, next);
      return;
    }
    if (ts.isJsxText(n)) {
      if (!ctx.verbatim) add(n, ctx.nav ? "nav" : ctx.heading ? "heading" : ctx.rail ? "rail" : "text", n.text);
      return;
    }
    if (ts.isJsxExpression(n)) {
      if (n.expression) visit(n.expression, ctx);
      return;
    }
    if (ts.isJsxAttributes(n)) return;
    if (ctx.inJsx && !ctx.verbatim) {
      const t = literalText(n);
      if (t !== undefined) {
        if (!isValueUse(n)) add(n, ctx.nav ? "nav" : ctx.heading ? "heading" : ctx.rail ? "rail" : "literal", t);
        // the interpolations may hold wording of their own (`${t.cwd}${local ? "\nTerminal で実行" : ""}`)
        if (ts.isTemplateExpression(n)) for (const span of n.templateSpans) visit(span.expression, ctx);
        return;
      }
    }
    ts.forEachChild(n, (c) => visit(c, ctx));
  };
  visit(src, { nav: false, heading: false, rail: false, verbatim: false, inJsx: false });
  return out;
}

export function collectUiStrings(dirs: string[], root = process.cwd()): UiString[] {
  return dirs.flatMap((d) => walkFiles(d)).flatMap((f) => collectFile(f, root));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const dirs = args.filter((a) => a !== "--check");
  const all = collectUiStrings(dirs.length ? dirs : ["apps/web/src"]);
  const shown = check ? all.filter((s) => s.verdict === "violation") : all;
  for (const s of shown) console.log(`${s.file}:${s.line}\t${s.kind}\t${s.lang}\t${s.verdict}\t${s.text}`);
  const bad = all.filter((s) => s.verdict === "violation").length;
  console.error(`${all.length} strings, ${bad} violation(s) — docs/design/ui-language.md`);
  if (check && bad) process.exit(1);
}
