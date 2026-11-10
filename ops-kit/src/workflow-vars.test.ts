// test-reads: ops.config.json .github/workflows/ ops-kit/template/ ops-kit/public/.github/workflows/
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A copy of the public repository under an organization that does not allow Actions gets no failure mail: every job
 * runs only where a repository variable says `on`, and a copy without the variable runs none. Each set has its own name.
 */
const root = join(import.meta.dir, "../..");
const read = (f: string) => Bun.YAML.parse(readFileSync(join(root, f), "utf8")) as { jobs: Record<string, { if?: string }> };
const conditions = (f: string) => Object.values(read(f).jobs).map((j) => j.if ?? "");
const workflows = (dir: string) => readdirSync(join(root, dir)).map((f) => `${dir}/${f}`);

// host.yml, release-tag.yml: manual or behind their own variable; project-autoadd.yml: behind <PREFIX>_PROJECT_URL
const OWN_GUARD = /\/(host|release-tag|project-autoadd)\.yml$/;
// The public kit's workflow: the sync adds it to the public tree's workflows, and the test below checks its condition on
// the copy under ops-kit/public/. Left out only while it is that copy, so a file of the same name with other jobs is checked.
const KIT_COPY = "ops-kit/public/.github/workflows/close-pull-requests.yml";
const kitCopy = (f: string) => f.endsWith("/close-pull-requests.yml") && readFileSync(join(root, f), "utf8") === readFileSync(join(root, KIT_COPY), "utf8");

test.each([
  [".github/workflows", `vars.${(JSON.parse(readFileSync(join(root, "ops.config.json"), "utf8")) as { envPrefix: string }).envPrefix}_ACTIONS == 'on'`],
  // format(): the template's placeholder is replaced as a whole word, so `__PREFIX___ACTIONS` would stay unfilled
  ["ops-kit/template/.github/workflows", "${{ vars[format('{0}_ACTIONS', '__PREFIX__')] == 'on' }}"],
])("every job under %s runs only with %s", (dir, condition) => {
  const files = workflows(dir).filter((f) => !OWN_GUARD.test(f) && !kitCopy(f));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) for (const c of conditions(f)) expect({ f, c }).toEqual({ f, c: condition });
});

test("the public kit's workflow runs only with vars.PUBLIC_ACTIONS on, on top of its exclusions", () => {
  for (const c of conditions(KIT_COPY)) expect(c).toMatch(/^\$\{\{ vars\.PUBLIC_ACTIONS == 'on'\s+&& /);
});
