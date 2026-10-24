import type { Workspace } from "@switchboard/protocol";
import { BRIEF_REQUEST_MARKER, workspaceBrief } from "./brief.ts";
import { jsonCandidates, oneLine, runSuggestionTurn, type SuggestionTurnOptions } from "./suggest-llm.ts";

/** How much of each Workspace's brief the model sees: the layout and instruction lines, not the whole text. */
const BRIEF_CHARS = 400;

export interface WorkspaceContext {
  title: string;
  prompt: string;
  /** The registered Workspaces. The answer is always one of these: nothing is registered on the model's say-so. */
  workspaces: Workspace[];
}

export interface WorkspaceChoice {
  workspaceId: string;
  reason: string;
}

/**
 * Asks a runner which registered Workspace a task belongs in (#135), when the person left the select on "自動".
 * Same turn as `LlmSuggester` (one read-only turn, JSON out), but the answer decides rather than advises, so there
 * is no rule table to fall back to: anything unusable throws, and `POST /api/tasks` answers 409.
 */
export class WorkspaceSuggester {
  constructor(private opts: SuggestionTurnOptions) {}

  async suggest(ctx: WorkspaceContext, signal: AbortSignal): Promise<WorkspaceChoice> {
    if (ctx.workspaces.length === 0) throw new Error("no workspace is registered");
    const text = await runSuggestionTurn(this.opts, buildWorkspacePrompt(ctx), signal);
    return parseWorkspaceChoice(text, ctx.workspaces);
  }
}

/** The prompt: instructions, the task, then one block per candidate. Names and briefs are the daemon's own text; the task is not trusted and is capped. */
export function buildWorkspacePrompt(ctx: WorkspaceContext): string {
  return [
    "あなたはタスクをどの Workspace（登録済みのリポジトリ）で実行するかを選びます。JSON だけを返してください。",
    'ほかの文章・コードブロック・前置きは書かないこと。形式: {"workspaceId": "<候補の id のいずれか>", "reason": "<日本語で 60 字以内の理由>"}',
    "",
    "## 判断してほしいタスク",
    `title: ${oneLine(ctx.title)}`,
    `prompt: ${oneLine(ctx.prompt).slice(0, 1200)}`,
    "",
    "## 候補の Workspace",
    ...ctx.workspaces.map((ws) => `- id: ${ws.id} / name: ${oneLine(ws.name)} / kind: ${ws.kind} / path: ${ws.path}\n  ${briefHead(ws)}`),
  ].join("\n");
}

/** The brief without its closing "やってほしいこと:" marker — that line addresses the agent doing the task, not the one choosing. */
function briefHead(ws: Workspace): string {
  return oneLine(workspaceBrief(ws).split(BRIEF_REQUEST_MARKER)[0]!).slice(0, BRIEF_CHARS);
}

/** The first JSON object naming a candidate (same scan as `parseSuggestion`). An id outside the list is never used. */
export function parseWorkspaceChoice(text: string, workspaces: Workspace[]): WorkspaceChoice {
  const rejected: string[] = [];
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const obj = parsed as { workspaceId?: unknown; reason?: unknown };
    if (typeof obj?.workspaceId !== "string") continue;
    // The prompt's format line carries a placeholder id; a model that echoes it must not end the search.
    if (!workspaces.some((ws) => ws.id === obj.workspaceId)) {
      rejected.push(obj.workspaceId);
      continue;
    }
    const reason = typeof obj.reason === "string" ? oneLine(obj.reason) : "";
    return { workspaceId: obj.workspaceId, reason: reason || "（理由なし）" };
  }
  if (rejected.length) throw new Error(`chose ${rejected.map((r) => JSON.stringify(r)).join(", ")}, none of which is a registered workspace`);
  throw new Error(`no JSON object in the answer: ${oneLine(text).slice(0, 200)}`);
}
