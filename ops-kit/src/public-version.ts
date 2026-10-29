/** Independent public versions. All source identities, plans and the cross-clone lock stay on private origin. */
import { createHash, randomUUID } from "node:crypto";
import { openSyncPr, releaseBaseline, TREES, type Options, type Run } from "./public-sync.ts";

type Release = { version: string; source: string; tag: string; tree: string; tags: Record<string, string> };
type State = { completed?: Release & { commit: string }; pending?: Release };
export type Publication = { version: string; prepare: (tree: string) => void };
const semver = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const numbers = (v: string) => {
  const m = semver.exec(v);
  if (!m) throw new Error(`not a strict version tag: ${v}`);
  const n = m.slice(1).map(Number);
  if (!n.every(Number.isSafeInteger)) throw new Error(`version is too large: ${v}`);
  return n;
};

export function independentSync(opts: Options, run: Run, publish: (publication: Publication, dryRun?: boolean) => string): string {
  const top = run(["git", "rev-parse", "--show-toplevel"]);
  if (top.code) throw new Error("cannot locate repository");
  const raw = (args: string[], input?: string) => run(["git", "-C", top.out, ...args], { input, env: { GIT_TERMINAL_PROMPT: "0" } });
  const git = (args: string[], input?: string) => {
    const r = raw(args, input);
    if (r.code) throw new Error(`independent version: failed git ${args[0]}`);
    return r.out;
  };
  if (!opts.source || !semver.test(opts.source)) throw new Error("independent version requires --source <vX.Y.Z tag>");
  const source = git(["rev-parse", "--verify", `refs/tags/${opts.source}^{commit}`]);
  const url = opts.targetUrl ?? `https://github.com/${opts.target}.git`;
  const key = createHash("sha256").update(url.toLowerCase()).digest("hex");
  const ref = `refs/public-sync/versions/${key}`, lock = `${ref}-lock`;
  const remote = (url: string, ...refs: string[]) => {
    const r = raw(["ls-remote", url, ...refs]);
    if (r.code) throw new Error(url === "origin" ? "cannot read private origin" : `cannot read public target ${opts.target}; create an empty Private repository first, or use an empty local bare with --target-url for dry-run`);
    return r.out;
  };
  const ancestor = (a: string, b: string) => {
    const r = raw(["merge-base", "--is-ancestor", a, b]);
    if (r.code > 1) throw new Error("cannot judge source ancestry");
    return r.code === 0;
  };
  let token: string | undefined;
  if (opts.dryRun) {
    if (remote("origin", lock)) throw new Error(`independent version lock exists: ${lock}`);
  } else {
    const empty = git(["hash-object", "-t", "tree", "-w", "--stdin"], "");
    token = git(["commit-tree", empty, "-m", randomUUID()]);
    if (raw(["push", "-q", `--force-with-lease=${lock}:`, "origin", `${token}:${lock}`]).code)
      throw new Error(`cannot acquire independent version lock: ${lock}; inspect private origin before recovery`);
  }
  let failure: unknown;
  try {
    const tagMap = (text: string) => {
      const map = new Map<string, string>();
      for (const line of text.split("\n")) {
        const [a, b] = line.split(/\s+/);
        const [name, sha] = [b, a];
        if (name && sha) map.set(name.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""), sha);
      }
      return map;
    };
    const localTags = tagMap(git(["show-ref", "--tags", "--dereference"]));
    const originTags = tagMap(remote("origin", "refs/tags/*"));
    const verifyTag = (tag: string, sha: string) => {
      if (localTags.get(tag) !== sha) throw new Error(`source tag changed: ${tag}`);
      if (originTags.get(tag) !== sha) throw new Error(`source tag missing or changed on origin: ${tag}`);
    };
    let state: State = {}, previous = remote("origin", ref).split(/\s/)[0] || "";
    if (previous) {
      git(["fetch", "-q", "origin", `+${ref}:${ref}`]);
      state = JSON.parse(git(["show", `${previous}:state.json`]));
      for (const entry of [state.completed, state.pending]) {
        if (!entry) continue;
        numbers(entry.version);
        for (const [tag, sha] of Object.entries(entry.tags)) {
          verifyTag(tag, sha);
        }
      }
    }
    const base = state.completed;
    const pending = state.pending;
    if (pending && (pending.source !== source || pending.tag !== opts.source)) throw new Error(`unfinished publication: resume with --source ${pending.tag}`);
    const main = remote(url, "refs/heads/main");
    const save = () => {
      const blob = git(["hash-object", "-w", "--stdin"], JSON.stringify(state));
      const tree = git(["mktree"], `100644 blob ${blob}\tstate.json\n`);
      const commit = git(["commit-tree", tree, "-p", source, ...(previous ? ["-p", previous] : []), "-m", "public version record"]);
      git(["push", "-q", `--force-with-lease=${ref}:${previous}`, "origin", `${commit}:${ref}`]);
      previous = commit;
    };
    if (opts.adoptBaseline) {
      // A published target without a record: its public main's commit, unchanged, becomes v0.1.0 when its tree's record names --source.
      if (base) throw new Error("public target already has an independent version record; sync without --adopt-baseline");
      if (!main) throw new Error("public main missing; --adopt-baseline is for a published target (an empty one starts at v0.1.0 by a plain sync)");
      git(["fetch", "-q", url, "+refs/heads/main:refs/public-sync/version-main"]);
      const commit = git(["rev-parse", "refs/public-sync/version-main"]);
      const tree = git(["rev-parse", "refs/public-sync/version-main^{tree}"]);
      if (pending && pending.tree !== tree) throw new Error("public main differs from the pending baseline");
      const record = remote("origin", `${TREES}/${tree}`).split(/\s/)[0];
      if (!record) throw new Error("public main's tree has no sync record on private origin; sync it with --adopted first");
      if (record !== source) throw new Error(`public main's tree was not sent from ${opts.source}`);
      verifyTag(opts.source, source);
      git(["fetch", "-q", "origin", "+refs/heads/main:refs/public-sync/version-source-main"]);
      if (!ancestor(source, "refs/public-sync/version-source-main")) throw new Error("source tag is not on private main");
      if (!pending) {
        const strict = (names: string) => names.split("\n").map((n) => n.replace(/^.*refs\/tags\//, "").replace(/\^\{\}$/, "")).filter((n) => semver.test(n));
        const tags = strict(remote(url, "refs/tags/v*"));
        if (tags.length) throw new Error(`public version tag already exists: ${tags[0]}`);
        if (!opts.targetUrl) {
          const releases = run(["gh", "api", "--paginate", `repos/${opts.target}/releases`, "--jq", ".[].tag_name"]);
          if (releases.code) throw new Error("cannot read public Releases");
          const found = releases.out.split("\n").filter((n) => semver.test(n));
          if (found.length) throw new Error(`public Release already exists: ${found[0]}`);
        }
        const [open] = openSyncPr(opts, run);
        if (open) throw new Error(`sync PR #${open} is open on ${opts.target}: close it first`);
      }
      const version = pending?.version ?? "v0.1.0";
      numbers(version);
      const head = `version: adopt baseline: source ${opts.source} (${source}), public main ${commit} tree ${tree}, public ${version}`;
      if (opts.dryRun) return `${head}\n${releaseBaseline(opts, run, commit, version)}`;
      if (!pending) { state.pending = { version, source, tag: opts.source, tree, tags: { [opts.source]: source } }; save(); }
      const out = releaseBaseline(opts, run, commit, version);
      git(["fetch", "-q", url, "+refs/heads/main:refs/public-sync/version-main"]);
      if (git(["rev-parse", "refs/public-sync/version-main"]) !== commit) throw new Error("public main moved while adopting the baseline");
      state = { completed: { ...state.pending!, commit } }; save();
      return `${head}\n${out}`;
    }
    if (main && !base && !pending) throw new Error("independent version baseline missing; run ops-kit public-sync --adopt-baseline --source <vX.Y.Z> (see README: 独立した公開バージョン)");
    if (!main && base) throw new Error("public main missing for recorded baseline");
    if (main) {
      git(["fetch", "-q", url, "+refs/heads/main:refs/public-sync/version-main"]);
      const title = git(["log", "-1", "--format=%s", "refs/public-sync/version-main"]);
      const tree = git(["rev-parse", "refs/public-sync/version-main^{tree}"]);
      const commit = git(["rev-parse", "refs/public-sync/version-main"]);
      if (!base && pending?.tree === tree && pending.version !== title) throw new Error(`unfinished baseline adoption: resume with --adopt-baseline --source ${pending.tag}`);
      // the completed commit is the exact identity: an adopted baseline keeps the title of the sync before it
      if (!(base?.tree === tree && base.commit === commit) && !(pending?.version === title && pending.tree === tree))
        throw new Error("public main differs from independent version record");
    }
    if (base && !ancestor(base.source, source)) throw new Error("source is older than or diverges from published baseline");
    verifyTag(opts.source, source);
    git(["fetch", "-q", "origin", "+refs/heads/main:refs/public-sync/version-source-main"]);
    if (!ancestor(source, "refs/public-sync/version-source-main")) throw new Error("source tag is not on private main");
    const tags = { ...base?.tags, [opts.source]: source };
    let bump = -1;
    if (base && source !== base.source) {
      // Order by commits, never by tag name: a minor/major reset hides earlier patch increments.
      const tagged = git(["tag", "--merged", source]).split("\n").filter((t) => semver.test(t));
      const byCommit = new Map<string, string>();
      for (const tag of tagged) {
        const sha = localTags.get(tag)!;
        if (ancestor(sha, base.source)) continue;
        verifyTag(tag, sha);
        if (byCommit.has(sha)) throw new Error("multiple version tags on one source commit");
        byCommit.set(sha, tag);
      }
      let prevSha = base.source, prevTag = base.tag;
      for (const sha of git(["rev-list", "--topo-order", "--reverse", `${base.source}..${source}`]).split("\n")) {
        const tag = byCommit.get(sha);
        if (!tag) continue;
        if (!ancestor(prevSha, sha)) throw new Error("release tag history diverges");
        const a = numbers(prevTag), b = numbers(tag);
        const changed = a.findIndex((v, i) => v !== b[i]);
        if (changed < 0 || b[changed]! < a[changed]!) throw new Error("source versions do not increase");
        bump = bump < 0 ? changed : Math.min(bump, changed);
        tags[tag] = sha; prevSha = sha; prevTag = tag;
      }
      if (prevSha !== source || bump < 0) throw new Error("source release interval is incomplete");
    }
    const n = base ? numbers(base.version) : [0, 1, 0];
    if (base && bump >= 0) { n[bump] = n[bump]! + 1; for (let i = bump + 1; i < 3; i++) n[i] = 0; }
    const version = pending?.version ?? `v${n.join(".")}`;
    numbers(version);
    let prepared = false;
    let preflight = !opts.dryRun;
    const publication: Publication = { version, prepare(tree) {
      if (pending && pending.tree !== tree) throw new Error("pending public tree changed; restore the reviewed publishing code/config");
      if (!pending && source === base?.source) throw new Error("same source produces a changed public tree; use a new development release");
      if (!pending && remote(url, `refs/tags/${version}`, `refs/tags/${version}^{}`)) throw new Error(`public version already exists: ${version}`);
      if (preflight) return;
      prepared = true;
      state.pending = { version, source, tag: opts.source!, tree, tags };
      if (!opts.dryRun && !pending) save();
    } };
    if (preflight) { publish(publication, true); preflight = false; }
    const out = publish(publication);
    if (!opts.dryRun && (prepared || pending)) {
      const expected = state.pending!;
      git(["fetch", "-q", url, "+refs/heads/main:refs/public-sync/version-main"]);
      if (git(["log", "-1", "--format=%s", "refs/public-sync/version-main"]) !== version || git(["rev-parse", "refs/public-sync/version-main^{tree}"]) !== expected.tree)
        throw new Error("publication did not land on the planned public version/tree");
      state = { completed: { ...expected, commit: git(["rev-parse", "refs/public-sync/version-main"]) } }; save();
    }
    return `version: source ${opts.source} (${source}), baseline ${base?.tag ?? "initial"}, bump ${["major", "minor", "patch"][bump] ?? "initial/unchanged"}, public ${version}\n${out}`;
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    if (token && raw(["push", "-q", `--force-with-lease=${lock}:${token}`, "origin", `:${lock}`]).code)
      throw new Error(`${failure instanceof Error ? failure.message + "; " : ""}could not release independent version lock: ${lock}; inspect private origin before recovery`);
  }
}
