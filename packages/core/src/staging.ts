import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, StagedChange } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { unifiedDiff } from "./diff.ts";
import { newId } from "./db.ts";
import type { Scope } from "./mcp.ts";

/**
 * Staged writes (proposal §3 "Workspace MCP", issue #11). `fs.write` / `fs.patch` never touch the repository:
 * the change is stored here with the file's content at staging time, shown to the user as a diff, and only written
 * when they apply it. A file that changed underneath a staged edit is a conflict and must be re-staged.
 *
 * Several pending edits to one file chain: a patch is applied on top of the latest pending `after` for that path,
 * and applying them in order reproduces the chain (each apply checks the file matches its `before`).
 */
export const MAX_STAGE_BYTES = 2 * 1024 * 1024;

export class Staging {
  constructor(
    private db: Db,
    private record: (taskId: string, ev: AgentEvent) => void,
  ) {}

  /** Stage a full-file write. */
  stageWrite(taskId: string, scope: Scope, path: string, content: string): StagedChange {
    if (Buffer.byteLength(content, "utf8") > MAX_STAGE_BYTES) throw new Error(`content over ${MAX_STAGE_BYTES} bytes`);
    const abs = scope.resolve(path);
    const before = this.baseline(taskId, abs);
    if (before === content) throw new Error("no change: the file already has this content");
    return this.insert(taskId, scope, abs, "write", before, content);
  }

  /** Stage an edit: `find` must occur exactly once in the current (or latest pending) content. */
  stagePatch(taskId: string, scope: Scope, path: string, find: string, replace: string): StagedChange {
    const abs = scope.resolve(path);
    const before = this.baseline(taskId, abs);
    if (before === null) throw new Error(`file not found: ${scope.display(abs)}`);
    if (find === replace) throw new Error("no change: `find` and `replace` are identical");
    const first = before.indexOf(find);
    if (first < 0) throw new Error("`find` text not found in the file (pending edits included)");
    if (before.indexOf(find, first + find.length) >= 0) throw new Error("`find` text occurs more than once; include more context");
    const after = before.slice(0, first) + replace + before.slice(first + find.length);
    if (Buffer.byteLength(after, "utf8") > MAX_STAGE_BYTES) throw new Error(`result over ${MAX_STAGE_BYTES} bytes`);
    return this.insert(taskId, scope, abs, "patch", before, after);
  }

  /** Current content the next edit builds on: the latest pending change for the path, else the file on disk. */
  private baseline(taskId: string, abs: string): string | null {
    const pending = this.db.listStaged(taskId).filter((c) => c.status === "pending" && c.path === abs).at(-1);
    if (pending) return pending.after;
    return readText(abs);
  }

  private insert(taskId: string, scope: Scope, abs: string, kind: "write" | "patch", before: string | null, after: string): StagedChange {
    const rel = scope.display(abs);
    const diff = unifiedDiff(before ?? "", after, rel);
    const change: StagedChange = { id: newId("stg"), taskId, path: abs, rel, kind, before, after, status: "pending", ts: Date.now(), decidedAt: null, diff, stat: diffStat(diff) };
    this.db.insertStaged(change);
    this.record(taskId, { t: "artifact", kind: "diff", path: rel, stat: change.stat });
    return change;
  }

  list(taskId: string): StagedChange[] {
    return this.db.listStaged(taskId);
  }

  /** Write a pending change. Refuses if the file moved on since it was staged (the diff the user saw is stale). */
  apply(id: string, scope: Scope): StagedChange {
    const c = this.db.getStaged(id);
    if (!c) throw new Error("staged change not found");
    if (c.status !== "pending") throw new Error(`already ${c.status}`);
    const abs = scope.resolve(c.path); // re-check containment with the task's current scope
    const current = readText(abs);
    if (current !== c.before) throw Object.assign(new Error("file changed since it was staged; stage the edit again"), { code: "ECONFLICT" });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c.after);
    const done = this.db.updateStaged(id, "applied");
    this.record(c.taskId, { t: "artifact", kind: "file", path: c.rel, stat: c.stat });
    return done!;
  }

  reject(id: string): StagedChange {
    const c = this.db.getStaged(id);
    if (!c) throw new Error("staged change not found");
    if (c.status !== "pending") throw new Error(`already ${c.status}`);
    const done = this.db.updateStaged(id, "rejected")!;
    this.record(c.taskId, { t: "status", text: `staged change rejected: ${c.rel}` });
    return done;
  }
}

/** Text of an existing file, null when absent. Directories and binary files are refused (a UTF-8 round trip would corrupt them). */
function readText(abs: string): string | null {
  if (!existsSync(abs)) return null;
  const st = statSync(abs);
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.size > MAX_STAGE_BYTES) throw new Error(`file over ${MAX_STAGE_BYTES} bytes`);
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) throw new Error("binary file; staged edits are text only");
  const text = buf.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== buf.length) throw new Error("file is not valid UTF-8; staged edits are text only");
  return text;
}

/** +added −removed counted from the unified diff itself (moves and duplicates count correctly). */
export function diffStat(diff: string): string {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return `+${add} −${del}`;
}
