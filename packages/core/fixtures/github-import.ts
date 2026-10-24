/**
 * A fake GitHub for the backlog import (#885), built on a gh that answers like the fixtures of the GitHub read before it
 * (`backlog-graphql.json` pages, `backlog-decisions.json` comments): tests and scripts/github-api-bench.ts keep those
 * fixtures and their per-test variations.
 */
import type { GhRunner } from "../src/backlog.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
/**
 * Answers the import's queries (#885) from a gh that answers like the fixtures: pages of open Issues (the query names
 * `issues(states:OPEN`), their comments and Tasks (`comments(last:`), the states of the waits (`issueOrPullRequest`).
 * A PBI's Tasks are its Tasks in the comments answer, then made up to its subIssuesSummary. A failed or malformed
 * answer goes to the import as it is.
 */
export function importing(legacy: GhRunner, pulls: () => Json[] = () => []): GhRunner {
  const ask = (cwd: string, query: string, after?: string) => legacy(["api", "graphql", "--include", "-f", `query=${query}`, "-F", "o=acme", "-F", "r=app", ...(after ? ["-f", `after=${after}`] : [])], cwd);
  const parse = (out: string): Json => {
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  };
  const raw = (n: number, x: Json, extra: Json) => ({
    id: `I_${n}`, number: n, title: x.title, url: x.url, state: x.state ?? "OPEN", stateReason: x.stateReason ?? null, body: x.body, createdAt: x.createdAt, updatedAt: x.updatedAt, milestone: null, parent: extra.parent ? { number: extra.parent } : null,
    labels: { totalCount: x.labels?.nodes?.length ?? 0, nodes: x.labels?.nodes ?? [] }, subIssues: { totalCount: (extra.subIssues ?? []).length, nodes: (extra.subIssues ?? []).map((m: number) => ({ number: m })) },
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: (extra.comments ?? []).map((c: Json, i: number) => ({ id: `C_${n}_${i}`, ...c })) },
    projectItems: { totalCount: x.projectItems?.nodes?.length ?? 0, nodes: (x.projectItems?.nodes ?? []).map((p: Json, i: number) => ({ id: `PVTI_${n}_${i}`, project: { number: p.project.number, owner: { login: "acme" } }, fieldValues: { totalCount: p.fieldValues.nodes.length, nodes: p.fieldValues.nodes } })) },
  });
  const task = (n: number, t: Json) => ({ title: `Task ${n}`, url: `https://github.com/acme/app/issues/${n}`, body: t.body ?? "", createdAt: "2026-09-01T00:00:00Z", updatedAt: t.updatedAt ?? "2026-09-01T00:00:00Z", state: t.state, stateReason: t.stateReason ?? null, labels: t.labels });
  /** Every Issue the fixtures' GitHub has, in the import's shape; or the answer that failed. */
  const issues = async (cwd: string): Promise<{ nodes: Json[]; head: string } | { failed: Awaited<ReturnType<GhRunner>> }> => {
    const pages: Json[] = [];
    let head = "";
    for (let after: string | undefined; ;) {
      const r = await ask(cwd, "issues(states:OPEN)", after);
      head ||= headOf(r.stdout);
      const page = parse(parseIncludedBody(r.stdout))?.data?.repository?.issues;
      if (r.code !== 0 || !Array.isArray(page?.nodes) || typeof page?.pageInfo?.hasNextPage !== "boolean") return { failed: r };
      pages.push(...page.nodes);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
    }
    const c = await ask(cwd, "comments(last:20)");
    const repository = parse(parseIncludedBody(c.stdout))?.data?.repository;
    if (c.code !== 0 || !repository) return { failed: c };
    const nodes: Json[] = [];
    for (const x of pages) {
      const alias = repository[`i${x.number}`] ?? {};
      const tasks: Json[] = [...(alias.subIssues?.nodes ?? [])];
      const total = x.subIssuesSummary?.total ?? 0;
      let closed = tasks.filter((t) => t.state === "CLOSED").length;
      for (let i = tasks.length; i < total; i++) tasks.push({ number: x.number * 100 + i, state: closed++ < (x.subIssuesSummary?.completed ?? 0) ? "CLOSED" : "OPEN", labels: { nodes: [{ name: "type:task" }] }, comments: { nodes: [] } });
      nodes.push(raw(x.number, x, { comments: alias.comments?.nodes, subIssues: tasks.map((t) => t.number) }));
      for (const t of tasks) nodes.push(raw(t.number, task(t.number, t), { parent: x.number, comments: t.comments?.nodes }));
    }
    return { nodes, head };
  };
  /** The open PRs a test put on its GitHub, in the import's shape: 50 to a page, the rest by cursor. */
  const pullPage = (later: boolean) => {
    const all = pulls().map((p) => ({
      id: `PR_${p.number}`, number: p.number, state: p.state ?? "OPEN", isDraft: !!p.isDraft, updatedAt: p.updatedAt ?? new Date().toISOString(), headRefName: p.headRefName ?? null, body: p.body ?? "",
      labels: { totalCount: p.labels?.length ?? 0, nodes: (p.labels ?? []).map((name: string) => ({ name })) },
      files: { totalCount: p.filesTotal ?? (p.files ?? []).length, nodes: (p.files ?? []).map((path: string) => ({ path })) },
    }));
    const nodes = later ? all.slice(50) : all.slice(0, 50);
    return { pageInfo: { hasNextPage: !later && all.length > 50, endCursor: !later && all.length > 50 ? "pulls-1" : null }, nodes };
  };
  return async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query="))?.slice(6) ?? "";
    const page = (nodes: Json[], head: string, withPulls = false) => ({ code: 0, stdout: head + JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, ...(withPulls ? { pullRequests: pullPage(q.includes("after:$after") && args.some((a) => a.startsWith("after="))) } : {}) } } }), stderr: "" });
    if (q.includes("pullRequests(first:50, after:$after")) {
      const r = await ask(cwd, "issues(states:OPEN)");
      return { code: 0, stdout: headOf(r.stdout) + JSON.stringify({ data: { repository: { pullRequests: pullPage(true) } } }), stderr: "" };
    }
    if (q.includes("states:[OPEN,CLOSED]") || q.includes("states:OPEN, labels")) {
      const all = await issues(cwd);
      if ("failed" in all) return all.failed;
      return page(q.includes("states:OPEN, labels") ? all.nodes.filter((n) => n.state === "OPEN") : all.nodes, all.head, q.includes("pullRequests(first:50"));
    }
    if (q.includes("issueOrPullRequest")) {
      const numbers = [...q.matchAll(/w(\d+): /g)].map((m) => Number(m[1]));
      const r = await ask(cwd, q);
      const states = parse(parseIncludedBody(r.stdout))?.data?.repository;
      if (r.code !== 0 || !states) return r;
      const repository: Json = {};
      const errors: Json[] = [];
      for (const n of numbers) {
        const w = states[`w${n}`];
        if (w?.__typename === "PullRequest") repository[`w${n}`] = { __typename: "PullRequest", id: `PR_${n}`, number: n, state: w.state, isDraft: !!w.isDraft, body: w.body ?? null, headRefName: w.headRefName ?? null, updatedAt: w.updatedAt ?? "2026-09-01T00:00:00Z", files: { totalCount: (w.files ?? []).length, nodes: (w.files ?? []).map((path: string) => ({ path })) }, mergeCommit: w.mergeCommit ?? null, labels: { totalCount: w.labels?.nodes?.length ?? 0, nodes: w.labels?.nodes ?? [] } };
        else if (w?.__typename === "Issue") repository[`w${n}`] = { __typename: "Issue", ...raw(n, task(n, w), { parent: w.parent?.number }) };
        else (repository[`w${n}`] = null), errors.push({ type: "NOT_FOUND", path: ["repository", `w${n}`] });
      }
      return { code: errors.length ? 1 : 0, stdout: headOf(r.stdout) + JSON.stringify({ data: { repository }, ...(errors.length ? { errors } : {}) }), stderr: "" };
    }
    return legacy(args, cwd);
  };
}
/**
 * The sends of the backlog edits kept here (#886, backlog-send.ts) for a gh that answers like the fixtures: a comment
 * (its marker taken off) and a label taken off become the `gh issue comment` / `gh issue edit --remove-label` calls those
 * fixtures record, and the check before a label change reads the Issue from the import's answer. Put it under
 * `importing`: `importing(sending(gh))`.
 */
export function sending(legacy: GhRunner): GhRunner {
  const read = importing(legacy);
  const ok = (body: Json) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify(body)}`, stderr: "" });
  return async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query="))?.slice(6) ?? "";
    if (args[1] === "graphql" && q.includes("issue(number:$n){ id title")) {
      const n = Number(args.find((a) => a.startsWith("n="))?.slice(2));
      const all = await read(["api", "graphql", "--include", "-f", "query=states:[OPEN,CLOSED]"], cwd);
      const i = parse(parseIncludedBody(all.stdout))?.data?.repository?.issues?.nodes?.find((x: Json) => x.number === n);
      if (all.code !== 0 || !i) return all.code !== 0 ? all : { code: 1, stdout: "", stderr: "HTTP 404" };
      return ok({ data: { repository: { issue: { id: i.id, title: i.title, body: i.body, state: i.state, milestone: null, parent: null, labels: i.labels } } } });
    }
    const m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/(comments|labels\/(.+))$/.exec(args[1] ?? "");
    if (args[0] === "api" && m && args.includes("POST") && m[3] === "comments") {
      const body = args.find((a) => a.startsWith("body="))!.slice(5);
      const r = await legacy(["issue", "comment", m[2]!, "-R", m[1]!, "--body", body.replace(/\n\n<!-- switchboard-op:[0-9a-f-]+ -->$/, "")], cwd);
      return r.code === 0 ? ok({ node_id: `C_sent_${m[2]}_${Date.now()}`, body, created_at: new Date().toISOString() }) : r;
    }
    if (args[0] === "api" && m && args.includes("DELETE") && m[4]) {
      const r = await legacy(["issue", "edit", m[2]!, "-R", m[1]!, "--remove-label", decodeURIComponent(m[4])], cwd);
      return r.code === 0 ? ok([]) : r;
    }
    return legacy(args, cwd);
  };
}

const parse = (out: string): Json => {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
};

const INCLUDED = /^HTTP\/[\d.]+ \d{3}[^\n]*\n[\s\S]*?\r?\n\r?\n/;
/** The status line and headers `gh api --include` put first (kept on the answers, for what the bench reads from them). */
const headOf = (out: string) => INCLUDED.exec(out)?.[0] ?? "";
const parseIncludedBody = (out: string) => out.replace(INCLUDED, "");

