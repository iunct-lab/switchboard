// test-reads: none
import { expect, test } from "bun:test";
import { openRequestsOf, realDepsCheckDeps, type KitRun } from "./deps-check-io.ts";
import { fakeGh } from "./gh.ts";

// a kit that answers from a table by the first two words of argv, and records every call
function fakeKit(answers: Record<string, { code: number; out: string }>): KitRun & { calls: string[][] } {
  const calls: string[][] = [];
  const kit = (async (argv: string[]) => {
    calls.push(argv);
    const a = answers[argv.slice(0, 2).join(" ")] ?? answers[argv[0]!];
    if (!a) throw new Error(`fakeKit: 想定していない ${argv.join(" ")}`);
    return a;
  }) as KitRun & { calls: string[][] };
  kit.calls = calls;
  return kit;
}

test("open requests: the numbered Issues and the app's open creates (one closed here is left out)", async () => {
  const listed = { items: [{ number: 12, title: "依存の更新: 2026-11" }], creates: [{ localId: "c_1", title: "依存の更新: 2026-12" }, { localId: "c_2", title: "x" }] };
  const views: Record<string, string> = { c_1: "OPEN", c_2: "CLOSED" };
  const calls: string[][] = [];
  const kit: KitRun = async (argv) => {
    calls.push(argv);
    if (argv[1] === "list") return { code: 0, out: JSON.stringify(listed) };
    return { code: 0, out: JSON.stringify({ issue: { state: views[argv[2]!] } }) };
  };
  expect(await openRequestsOf(kit)).toEqual([
    { ref: "#12", title: "依存の更新: 2026-11" },
    { ref: "c_1", title: "依存の更新: 2026-12" },
  ]);
  expect(calls[0]).toEqual(["backlog", "list", "--fresh", "--json", "--label", "type:request"]);
});

test("open requests: a list or a view that fails throws (nothing is filed on a guess)", async () => {
  await expect(openRequestsOf(fakeKit({ "backlog list": { code: 1, out: "" } }))).rejects.toThrow("判定できないので起票しない");
  const kit = fakeKit({ "backlog list": { code: 0, out: JSON.stringify({ items: [], creates: [{ localId: "c_1", title: "t" }] }) }, "backlog view": { code: 2, out: "" } });
  await expect(openRequestsOf(kit)).rejects.toThrow("c_1 を読めなかった");
  // the list's shape changed: a parse error, not "no open request"
  await expect(openRequestsOf(fakeKit({ "backlog list": { code: 0, out: "not json" } }))).rejects.toThrow();
});

test("fileRequest: `request <title> <file>` with the body; the number from its 要望を作成 line, null while unsent", async () => {
  let seen = "";
  const kitOf = (out: string): KitRun => async (argv) => {
    seen = await Bun.file(argv[2]!).text();
    return { code: 0, out };
  };
  const io = { out: () => {}, err: () => {} };
  const numbered = realDepsCheckDeps(fakeGh([]), {}, kitOf(">> 要望を作成: #77（アプリに保存）\n"), io);
  expect(await numbered.fileRequest("依存の更新: 2026-11", "## 要望\n")).toBe("#77");
  expect(seen).toBe("## 要望\n");
  const unsent = realDepsCheckDeps(fakeGh([]), {}, kitOf("GitHub への送信待ち\n"), io);
  expect(await unsent.fileRequest("t", "b")).toBeNull();
  const failed = realDepsCheckDeps(fakeGh([]), {}, async () => ({ code: 1, out: "no" }), io);
  await expect(failed.fileRequest("t", "b")).rejects.toThrow("request が exit 1");
});

test("comment: `backlog comment <n> --body-file`; a failure throws", async () => {
  const kit = fakeKit({ "backlog comment": { code: 0, out: "" } });
  const deps = realDepsCheckDeps(fakeGh([]), {}, kit, { out: () => {}, err: () => {} });
  await deps.comment("#12", "b");
  expect(kit.calls[0]!.slice(0, 4)).toEqual(["backlog", "comment", "12", "--body-file"]);
  const bad = realDepsCheckDeps(fakeGh([]), {}, fakeKit({ "backlog comment": { code: 1, out: "" } }), { out: () => {}, err: () => {} });
  await expect(bad.comment("#12", "b")).rejects.toThrow("#12 にコメントできなかった");
});

test("cli: deps-check takes only --file-request (exit 2 with the usage otherwise)", async () => {
  const { main } = await import("./cli.ts");
  const err: string[] = [];
  expect(await main(["deps-check", "--bogus"], fakeGh([]), () => {}, (s) => err.push(s))).toBe(2);
  expect(err.join("\n")).toContain("deps-check [--file-request]");
});

test("cli: deps-check --help prints its usage (exit 0)", async () => {
  const { main } = await import("./cli.ts");
  const out: string[] = [];
  expect(await main(["deps-check", "--help"], fakeGh([]), (s) => out.push(s), () => {})).toBe(0);
  expect(out.join("\n")).toContain("--file-request: 当たれば題「依存の更新: <YYYY-MM>」");
});
