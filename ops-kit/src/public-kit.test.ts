import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The public-side set (`public/`): what every public repository gets — the README section with the policy, the one
 * Issue form (a request), `SECURITY.md`, and the workflow that closes pull requests from outside. `public-sync` puts
 * it into the tree it sends. The set names no repository: its one placeholder is `__PUBLIC_REPO__`, the public
 * repository's `owner/name`.
 */
const pub = join(import.meta.dir, "../public");
const README_SECTION = "README.section.md";
const REQUEST = ".github/ISSUE_TEMPLATE/request.yml";
const CONFIG = ".github/ISSUE_TEMPLATE/config.yml";
const SECURITY = "SECURITY.md";
const WORKFLOW = ".github/workflows/close-pull-requests.yml";
const FILES = [README_SECTION, REQUEST, CONFIG, SECURITY, WORKFLOW];
const read = (rel: string) => readFileSync(join(pub, rel), "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("public kit: the set is exactly these files, and __PUBLIC_REPO__ is its only placeholder", () => {
  expect(files(pub).map((f) => relative(pub, f)).sort()).toEqual([...FILES].sort());
  const placeholders = new Set(FILES.flatMap((f) => read(f).match(/__[A-Z_]+__/g) ?? []));
  expect([...placeholders]).toEqual(["__PUBLIC_REPO__"]);
  for (const f of [README_SECTION, CONFIG, SECURITY]) expect({ f, named: read(f).includes("https://github.com/__PUBLIC_REPO__/") }).toEqual({ f, named: true });
});

test("public kit: the workflow answers and closes an outside pull request without running its code", () => {
  const wf = read(WORKFLOW);
  expect(wf).toContain("pull_request_target:");
  expect(wf).toContain("types: [opened, reopened]");
  expect(wf).not.toContain("actions/checkout");
  expect(wf).not.toContain("secrets.");
  expect(wf).toContain("GH_TOKEN: ${{ github.token }}");
  const permissions = wf.slice(wf.indexOf("permissions:"), wf.indexOf("jobs:")).trim().split("\n").map((l) => l.trim());
  expect(permissions).toEqual(["permissions:", "pull-requests: write"]);
  // the three exclusions: maintainers, dependabot, this repository's own sync branches (a fork's sync/* is closed)
  const condition = wf.slice(wf.indexOf("if:"), wf.indexOf("runs-on:"));
  for (const w of ["github.event.pull_request.author_association", '"OWNER"', '"MEMBER"', '"COLLABORATOR"', "github.event.pull_request.user.login != 'dependabot[bot]'", "github.event.pull_request.head.repo.full_name == github.repository", "startsWith(github.event.pull_request.head.ref, 'sync/')"]) {
    expect({ w, excluded: condition.includes(w) }).toEqual({ w, excluded: true });
  }
  expect(wf.indexOf("gh pr comment")).toBeGreaterThan(-1);
  expect(wf.indexOf("gh pr close")).toBeGreaterThan(wf.indexOf("gh pr comment"));
  // the pull request's title and body never reach the shell: only its URL and this repository's, through env
  expect(wf).not.toMatch(/pull_request\.(title|body)/);
});

test("public kit: config.yml takes no blank Issue and points at Discussions and the Security Advisory", () => {
  const cfg = read(CONFIG);
  expect(cfg).toContain("blank_issues_enabled: false");
  expect(cfg.match(/^\s+url: (.*)$/gm)?.map((l) => l.trim())).toEqual(["url: https://github.com/__PUBLIC_REPO__/discussions", "url: https://github.com/__PUBLIC_REPO__/security/advisories/new"]);
});

test("public kit: the one Issue form is a Request with three fields and no label; no PBI or Task anywhere in the set", () => {
  const req = read(REQUEST);
  expect(req).toContain("name: Request");
  expect(req).toContain('title: "Request: "');
  expect(req).not.toContain("labels:");
  expect(req.match(/^\s+label: (.*)$/gm)?.map((l) => l.trim())).toEqual(["label: What you want", "label: Why", "label: What happened (for a bug)"]);
  expect(req.slice(req.indexOf("label: What you want"), req.indexOf("label: Why"))).toContain("required: true");
  for (const f of FILES) expect({ f, stages: /\b(PBI|Task)\b/.test(read(f)) }).toEqual({ f, stages: false });
});

test("public kit: the README section says the four things, SECURITY.md keeps the two general sections, and the kit README lists public/", () => {
  const section = read(README_SECTION);
  expect(section.startsWith("## How this repository works\n")).toBe(true);
  expect(section.match(/^## /gm)?.length).toBe(1);
  for (const w of ["read-only copy", "Pull requests are not accepted", "Request", "security/advisories/new", "/discussions"]) expect({ w, said: section.includes(w) }).toEqual({ w, said: true });
  expect(read(SECURITY).match(/^## .*$/gm)).toEqual(["## Supported versions", "## Reporting a vulnerability"]);
  expect(readFileSync(join(import.meta.dir, "../README.md"), "utf8")).toMatch(/^\| `public\/` \| /m);
});
