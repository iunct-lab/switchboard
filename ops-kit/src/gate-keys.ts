import { dirname } from "node:path";
import { findConfig, mergeGateOf } from "./config.ts";
import { pathsIn } from "./task-paths.ts";

// A PBI whose Tasks touch what the merge gate covers (`mergeGate`'s `--gate-paths` says which) is not made Ready without a
// `## ゲートの鍵` section; when it says the keys change, a question that copies the section and an answer given on the screen
// are needed too. Only the app's mark (`screen`) tells a screen answer from one a Task wrote with `backlog comment`.

const HEADING = "## ゲートの鍵";

/** The `## ゲートの鍵` section of a body: whether the keys change and the section's text; null when its form is wrong (no mark line, or no table row). */
export function gateKeysSection(body: string): { change: "あり" | "なし"; text: string } | null {
  const lines = body.split("\n").map((l) => l.trimEnd());
  const from = lines.findIndex((l) => l === HEADING);
  if (from < 0) return null;
  const rest = lines.slice(from + 1);
  const next = rest.findIndex((l) => l.startsWith("## "));
  const section = (next < 0 ? rest : rest.slice(0, next)).filter((l) => l !== "");
  const change = /^\*\*鍵の変更\*\*: (あり|なし)$/.exec(section[0] ?? "")?.[1] as "あり" | "なし" | undefined;
  if (!change || !section.slice(1).some((l) => l.startsWith("|"))) return null;
  return { change, text: [HEADING, ...section].join("\n") };
}

interface Read {
  issue: { body: string; subIssues: number[] };
  comments: Array<{ body: string; screen?: true }>;
}

/** Why the PBI may not be Ready (what to write so that it can); null = it may. `gatePaths`: the given paths the merge gate covers. */
export async function readyRefusal(pbi: Read, tasks: Read[], gatePaths: (paths: string[]) => Promise<string[]>, top: { name: string; dir: boolean }[]): Promise<string | null> {
  const paths = [...new Set(tasks.flatMap((t) => pathsIn(t.issue.body, top)))];
  const gate = paths.length ? await gatePaths(paths) : [];
  if (!gate.length) return null;
  const why = `子 Task がゲートのパス（${gate.slice(0, 3).join("・")}${gate.length > 3 ? " ほか" : ""}）を名指ししています`;
  const mine = gateKeysSection(pbi.issue.body);
  if (!mine) return `${why}。本文に \`${HEADING}\` の節（\`**鍵の変更**: あり|なし\` の行と、鍵の表 1 行以上）を書いてください`;
  if (mine.change === "なし") return null;
  const asked = pbi.comments.flatMap((c, at) => {
    const s = c.body.startsWith("## 判断待ち") ? gateKeysSection(c.body) : null;
    return s ? [{ at, text: s.text }] : [];
  });
  if (!asked.length) return `${why}。\`**鍵の変更**: あり\` なので、本文の節を写した \`## 判断待ち\` の問いを出して、画面で答えてもらってください`;
  const same = asked.filter((q) => q.text === mine.text).at(-1);
  if (!same) return `${why}。本文の \`${HEADING}\` が問いの写しと違います（回答の後に表を変えたなら、問いを出し直して画面で答えてもらってください）`;
  const answered = pbi.comments.slice(same.at + 1).some((c) => c.body.startsWith("## 回答") && c.screen === true);
  return answered ? null : `${why}。表を写した問いに、画面からの \`## 回答\` がありません（Task が \`backlog comment\` で書いた回答は数えません。利用者に画面で答えてもらってください）`;
}

/** The merge gate's script and the directory it runs in (the one with `ops.config.json`); null when there is no `mergeGate`. */
export function gateScriptOf(cwd?: string): { dir: string; script: string } | null {
  const script = mergeGateOf(cwd);
  if (script === null) return null;
  try {
    return { dir: dirname(findConfig(undefined, cwd)), script };
  } catch {
    return null;
  }
}

/** The paths the gate covers among `paths`, asked of the gate's script (`--gate-paths`); throws when it cannot be run or does not exit 0. */
export async function runGatePaths(cwd: string, script: string, paths: string[]): Promise<string[]> {
  const p = Bun.spawn(["bun", script, "--gate-paths", ...paths], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${script} --gate-paths が exit ${code} で終わりました: ${err.trim()}`);
  return out.split("\n").filter((l) => l !== "");
}

/**
 * The check before an Issue is made Ready: its sub-Issues are read with `read`, and the reason it may not be (a failure to ask the gate
 * counts as a reason); null = it may, or there is nothing to ask (no `mergeGate`).
 */
export async function readyGateCheck(read: (n: number) => Promise<Read>, ref: number, cwd: string | undefined, top: { name: string; dir: boolean }[], run: typeof runGatePaths = runGatePaths): Promise<string | null> {
  const gate = gateScriptOf(cwd);
  if (!gate) return null;
  const pbi = await read(ref);
  const tasks = await Promise.all(pbi.issue.subIssues.map(read));
  try {
    return await readyRefusal(pbi, tasks, (paths) => run(gate.dir, gate.script, paths), top);
  } catch (e) {
    return `ゲートのパスを確かめられません（${(e as Error).message}）`;
  }
}
