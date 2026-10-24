import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { segments, sharedTmpWrites } from "./shared-tmp.ts";

const HOOK = join(import.meta.dir, "../bin/deny-shared-tmp");

describe("sharedTmpWrites", () => {
  test("a write or a removal of a fixed name under /tmp is named (#764 acceptance criterion 1)", () => {
    const stops: [string, string[]][] = [
      ["cat > /tmp/pr.md", ["/tmp/pr.md"]],
      ["echo x >> /tmp/x", ["/tmp/x"]],
      ["echo x>/tmp/x", ["/tmp/x"]],
      ["make 2> /tmp/err.log", ["/tmp/err.log"]],
      ["make &> /tmp/all.log", ["/tmp/all.log"]],
      ["echo x >| /tmp/x", ["/tmp/x"]],
      ["echo x | tee /tmp/x", ["/tmp/x"]],
      ["tee -a /tmp/x < in", ["/tmp/x"]],
      ["cp a /tmp/x", ["/tmp/x"]],
      ["mv -f a b /tmp/dir", ["/tmp/dir"]],
      ["rm -rf /tmp/review1", ["/tmp/review1"]],
      ["rm -rf /tmp/review*", ["/tmp/review*"]],
      ["mkdir /tmp/review1/a", ["/tmp/review1/a"]],
      ["touch /private/tmp/x", ["/private/tmp/x"]],
      ["git worktree add --detach /tmp/wt origin/main", ["/tmp/wt"]],
      ["git -C repo clone --depth 1 https://example.com/r.git /tmp/r", ["/tmp/r"]],
      ["cd repo && cat > '/tmp/post review.sh' <<'EOF'\nrm -rf /tmp/inside-the-body\nEOF\nrm /tmp/after", ["/tmp/post review.sh", "/tmp/after"]],
      ["X=1 sudo rm /tmp/a; /bin/rm /tmp/b", ["/tmp/a", "/tmp/b"]],
      ["echo $(echo x > /tmp/in-subshell)", ["/tmp/in-subshell"]],
      ["for f in a b; do cp $f /tmp/x; done", ["/tmp/x"]],
      ["if true; then rm -rf /tmp/review1; else rm /tmp/b; fi", ["/tmp/review1", "/tmp/b"]],
      ["while read l; do echo $l >> /tmp/w; done < in", ["/tmp/w"]],
      ["{ rm /tmp/x; }", ["/tmp/x"]],
      ["! rm /tmp/x", ["/tmp/x"]],
      ["cat > /tmp//pr.md", ["/tmp//pr.md"]],
      ["cat > /tmp/sb.pr.XXXXXX", ["/tmp/sb.pr.XXXXXX"]],
      ["cat > /tmp/build.20261001", ["/tmp/build.20261001"]],
    ];
    for (const [command, paths] of stops) expect({ command, paths: sharedTmpWrites(command) }).toEqual({ command, paths });
    // a name after a dot in lower case only is not one mktemp made
    expect(sharedTmpWrites("cat > /tmp/notes.backup")).toEqual(["/tmp/notes.backup"]);
  });

  test("mktemp, its result, reads of /tmp, and other paths are not named (#764 acceptance criterion 2)", () => {
    const passes = [
      "W=$(mktemp -d /tmp/sb.pr.XXXXXX)",
      "W=$(mktemp -d /tmp/sb.pr.XXXXXX); echo \"$W\"",
      'cat > "$W/pr.md"',
      "rm -rf \"$W\"",
      "cat > /tmp/repo.pbi1.AuCZE8/body.md",
      "rm -rf /tmp/repo.review12.x7Qp2a",
      "echo x > /tmp/tmp.AbCdEfGhIj/out",
      "ls /tmp",
      "cat /tmp/x",
      "grep -r foo /tmp/x < /tmp/y",
      "cp /tmp/x ./here",
      "echo x > ./tmp/x",
      "echo x > /tmp",
      "echo x > /var/tmp/x",
      "make 2>&1 | tail",
      "make >&2",
      "echo '> /tmp/x' \"rm /tmp/y\"",
      "gh pr comment 1 --body 'cat > /tmp/pr.md is stopped'",
      "# rm -rf /tmp/x\nls",
      "cat > \"$W/pr.md\" <<'EOF'\n- cat > /tmp/pr.md\n- rm -rf /tmp/review1\nEOF",
      "git clone https://example.com/r.git",
    ];
    for (const command of passes) expect({ command, paths: sharedTmpWrites(command) }).toEqual({ command, paths: [] });
  });

  test("segments: split on the separators outside quotes, here-document bodies dropped", () => {
    expect(segments("a && b || c; d | e & f\ng")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(segments("echo 'a; b' \"c && d\"")).toEqual(["echo 'a; b' \"c && d\""]);
    expect(segments("W=$(mktemp -d /tmp/x.XXXXXX)")).toEqual(["W=$", "mktemp -d /tmp/x.XXXXXX"]);
    expect(segments("cat <<EOF > f\nbody; rm x\nEOF\nls")).toEqual(["cat <<EOF > f", "ls"]);
    expect(segments("make 2>&1 >/dev/null")).toEqual(["make 2>&1 >/dev/null"]);
  });
});

describe("ops-kit/bin/deny-shared-tmp", () => {
  function run(stdin: string) {
    const p = Bun.spawnSync([HOOK], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, err: p.stderr.toString() };
  }
  const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  test("a write to a fixed name stops: exit 2, one line per path that says to use mktemp -d", () => {
    const r = run(bash("cat > /tmp/pr.md && rm -rf /tmp/review1"));
    expect(r.code).toBe(2);
    expect(r.err.trim().split("\n")).toEqual([
      "deny-shared-tmp: /tmp 直下の固定の名前（/tmp/pr.md）に書く・消すコマンドは止めます。W=$(mktemp -d /tmp/<用途>.XXXXXX) の下を使ってください",
      "deny-shared-tmp: /tmp 直下の固定の名前（/tmp/review1）に書く・消すコマンドは止めます。W=$(mktemp -d /tmp/<用途>.XXXXXX) の下を使ってください",
    ]);
  });

  test("allowed commands, other tools, and input it cannot read go through: exit 0", () => {
    for (const stdin of [
      bash('W=$(mktemp -d /tmp/sb.pr.XXXXXX) && cat > "$W/pr.md"'),
      bash("ls /tmp"),
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/pr.md" } }),
      JSON.stringify({ tool_name: "Bash", tool_input: {} }),
      "not json",
      "",
    ]) {
      expect({ stdin, ...run(stdin) }).toEqual({ stdin, code: 0, err: "" });
    }
  });
});
