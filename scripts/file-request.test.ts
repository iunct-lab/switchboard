import { describe, expect, test } from "bun:test";
import { type FileDeps, fileRequest, openRequests } from "./file-request";

const TITLE = "定期の検査: モデル一覧のズレ";
const LIST = { creates: [{ localId: "op_7f3a", title: "アプリだけの要望" }, { localId: "op_9c1d", title: "閉じた作成" }] };
const VIEW: Record<string, string> = { op_7f3a: "OPEN", op_9c1d: "CLOSED" };
const RECORDS = {
  issues: [
    { number: 2875, title: TITLE, state: "OPEN", labels: ["type:request"] },
    { number: 2876, title: "PBI: 同じ題でも PBI", state: "OPEN", labels: ["type:pbi"] },
    { number: 2000, title: "閉じた要望", state: "CLOSED", labels: ["type:request"] },
  ],
};

/** A fake run: what each command answers, and every command it was asked. */
function fake(opts: { env?: Record<string, string | undefined>; list?: { out: string; code: number }; view?: { out: string; code: number }; records?: FileDeps["records"] } = {}) {
  const calls: string[][] = [];
  const deps: FileDeps = {
    env: opts.env ?? { BACKLOG_URL: "http://127.0.0.1:1/api/backlog", GH_REPO: "acme/app" },
    exec: async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("view")) return opts.view ?? { out: JSON.stringify({ issue: { state: VIEW[cmd[cmd.indexOf("view") + 1]!] } }), code: 0 };
      if (cmd.includes("backlog")) return opts.list ?? { out: JSON.stringify(LIST), code: 0 };
      if (cmd[0] === "gh") return { out: `${JSON.stringify({ number: 12, title: TITLE })}\n`, code: 0 };
      return { out: ">> 要望を作成: #3000\n", code: 0 };
    },
    records: opts.records ?? (async () => RECORDS),
  };
  return { deps, calls, filed: () => calls.some((c) => c.some((a) => a.endsWith("request_issue.sh"))) };
}

describe("fileRequest", () => {
  test("アプリの Task: the stored open requests and creates, gh api is not called", async () => {
    const f = fake();
    expect(await openRequests(f.deps)).toEqual([
      { ref: "#2875", title: TITLE },
      { ref: "op_7f3a", title: "アプリだけの要望" },
    ]);
    expect(f.calls.some((c) => c[0] === "gh")).toBe(false);
    expect(f.calls[0]).toEqual(expect.arrayContaining(["backlog", "list", "--fresh", "--json"]));
  });

  test("番号つきの保存値: the same title as a stored numbered request → not filed, its number", async () => {
    const f = fake();
    expect(await fileRequest({ title: TITLE, body: "b" }, f.deps)).toEqual({ open: "#2875" });
    expect(f.filed()).toBe(false);
  });

  test("番号の付いていない作成: the same title as a create GitHub has not numbered → not filed, its localId", async () => {
    const f = fake();
    expect(await fileRequest({ title: "アプリだけの要望", body: "b" }, f.deps)).toEqual({ open: "op_7f3a" });
    expect(f.filed()).toBe(false);
    // a closed request, a create closed here, or a PBI of the same title is not an open request
    for (const title of ["閉じた要望", "閉じた作成"]) {
      const g = fake();
      expect(await fileRequest({ title, body: "b" }, g.deps)).toEqual({ filed: 3000 });
      expect(g.filed()).toBe(true);
    }
  });

  test("アプリが答えない: backlog list exit ≠ 0 or the records unread → throws, request_issue.sh is not run", async () => {
    const f = fake({ list: { out: "", code: 2 } });
    await expect(fileRequest({ title: TITLE, body: "b" }, f.deps)).rejects.toThrow("アプリから開いている要望を読めなかった（ops-kit backlog list exit 2）。判定できないので起票しない");
    expect(f.filed()).toBe(false);
    expect(f.calls.some((c) => c[0] === "gh")).toBe(false);
    const g = fake({ records: async () => { throw new Error("down"); } });
    await expect(fileRequest({ title: TITLE, body: "b" }, g.deps)).rejects.toThrow("判定できないので起票しない");
    expect(g.filed()).toBe(false);
    const h = fake({ view: { out: "", code: 2 } });
    await expect(fileRequest({ title: TITLE, body: "b" }, h.deps)).rejects.toThrow("アプリから op_7f3a を読めなかった（ops-kit backlog view exit 2）。判定できないので起票しない");
    expect(h.filed()).toBe(false);
  });

  test("Task の外: REST as before", async () => {
    const f = fake({ env: {} });
    expect(await fileRequest({ title: TITLE, body: "b" }, f.deps)).toEqual({ open: "#12" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual(expect.arrayContaining(["gh", "api", expect.stringMatching(/^repos\/[^/]+\/[^/]+\/issues$/), "labels=type:request"]));
  });
});
