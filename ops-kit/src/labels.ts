import type { GhClient } from "./gh.ts";

export interface Label {
  name: string;
  color: string;
  description?: string;
}

/**
 * The labels of a `.github/labels.yml` (a list of name / color / description; the color is 6 hex digits without #).
 * A color YAML reads as a number (`5319e7`, `000000`) is refused: quote it, its digits are already lost.
 */
export function parseLabels(yaml: string): Label[] {
  const list = Bun.YAML.parse(yaml);
  if (!Array.isArray(list)) throw new Error("labels.yml がラベルの一覧ではありません");
  return list.map((l: any, i: number) => {
    if (typeof l?.name !== "string" || typeof l?.color !== "string" || !/^[0-9a-fA-F]{6}$/.test(l.color)) throw new Error(`labels.yml の ${i + 1} 件目に name か 6 桁の color（文字列。数に読める色は "" で囲む）がありません`);
    return { name: l.name, color: l.color.toLowerCase(), description: typeof l.description === "string" ? l.description : "" };
  });
}

/**
 * Make the repository's labels match `want` (#916): create the missing ones, update the color / description (and the
 * case of the name) of the changed ones. A label of the repository that `want` does not list is never deleted
 * (the `skip-delete` of the workflow it replaces), so a second run changes nothing. GitHub compares names without case.
 * `dryRun`: only list the changes. Resolves to the changes, `create <name>` / `update <name>`.
 */
export async function syncLabels(gh: GhClient, repo: string, want: Label[], opts: { dryRun?: boolean } = {}, log: (s: string) => void = console.log): Promise<string[]> {
  const have: Array<{ name: string; color: string; description: string | null }> = [];
  for (let page = 1; ; page++) {
    const got = (await gh.api(`repos/${repo}/labels?per_page=100&page=${page}`)) as typeof have;
    have.push(...got);
    if (got.length < 100) break;
  }
  const changes: string[] = [];
  for (const l of want) {
    const cur = have.find((h) => h.name.toLowerCase() === l.name.toLowerCase());
    const body = { color: l.color, description: l.description ?? "" };
    if (!cur) {
      changes.push(`create ${l.name}`);
      if (!opts.dryRun) await gh.api(`repos/${repo}/labels`, { method: "POST", body: { name: l.name, ...body } });
    } else if (cur.name !== l.name || cur.color.toLowerCase() !== l.color || (cur.description ?? "") !== body.description) {
      changes.push(`update ${l.name}`);
      if (!opts.dryRun) await gh.api(`repos/${repo}/labels/${encodeURIComponent(cur.name)}`, { method: "PATCH", body: { new_name: l.name, ...body } });
    }
  }
  for (const c of changes) log(`>> ${opts.dryRun ? "(dry-run) " : ""}${c}`);
  log(`${opts.dryRun ? "変える" : "変えた"}: ${changes.length} 件（labels.yml に無いラベルは消さない）`);
  return changes;
}
