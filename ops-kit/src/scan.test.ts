import { describe, expect, test } from "bun:test";
import { fakeGh, GhError } from "./gh.ts";
import { ScanFetchError, scanIssues } from "./scan.ts";

const code = ["QWJK", "ZRTP"].join("-");
const row = (n: number, body: string | null, title?: string) => ({ html_url: `https://github.example/o/r/issues/${n}`, body, ...(title === undefined ? {} : { title }) });

describe("scanIssues", () => {
  test("a name of the host's AWS config is a hit of its own kind", async () => {
    const gh = fakeGh([() => [row(5, "一行目\naws --profile x-admin")], () => [], () => []]);
    expect(await scanIssues(gh, "o/r", Bun.sleep, { names: ["x-admin"], accountIds: [] })).toEqual({ hits: [{ url: "https://github.example/o/r/issues/5", kind: "aws-profile", line: 2 }], scanned: 1 });
  });

  test("an account id of the host's AWS config hits written bare; without the config it does not", async () => {
    const id = ["8642", "9753", "1086"].join("");
    const rows = () => fakeGh([() => [row(6, `一行目\nメモ ${id}`)], () => [], () => []]);
    expect(await scanIssues(rows(), "o/r", Bun.sleep, { names: [], accountIds: [id] })).toEqual({ hits: [{ url: "https://github.example/o/r/issues/6", kind: "account-id", line: 2 }], scanned: 1 });
    expect(await scanIssues(rows(), "o/r")).toEqual({ hits: [], scanned: 1 });
  });

  test("reads issues, comments and review comments, page by page, and names the place and the kind", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i + 1, "着手: 枝 sb/1-x"));
    const gh = fakeGh([
      () => full,
      () => [row(101, null, "題だけ"), row(102, `一行目\n承認 https://d.example/?user_code=${code}`, "題")],
      () => [row(7, `コード ${code}`)],
      () => [],
    ]);
    expect(await scanIssues(gh, "o/r")).toEqual({
      hits: [
        // the approval URL carries the code, and "user_code" calls it one: both kinds
        { url: "https://github.example/o/r/issues/102", kind: "approval-url", line: 2 },
        { url: "https://github.example/o/r/issues/102", kind: "device-code", line: 2 },
        { url: "https://github.example/o/r/issues/7", kind: "device-code", line: 1 },
      ],
      scanned: 103,
    });
    expect(gh.calls.map((c) => (c.kind === "api" ? c.path : ""))).toEqual([
      "repos/o/r/issues?state=all&per_page=100&page=1",
      "repos/o/r/issues?state=all&per_page=100&page=2",
      "repos/o/r/issues/comments?per_page=100&page=1",
      "repos/o/r/pulls/comments?per_page=100&page=1",
    ]);
  });

  test("scanIssues reads pull request review bodies", async () => {
    const pr = { ...row(5, "PR の本文"), number: 5, pull_request: {} };
    const gh = fakeGh([
      () => [row(4, "Issue"), pr],
      () => [],
      () => [],
      () => [{ html_url: "https://github.example/o/r/pull/5#pullrequestreview-1", body: `LGTM\nコード ${code}` }, { html_url: "https://github.example/o/r/pull/5#pullrequestreview-2", body: "" }],
    ]);
    expect(await scanIssues(gh, "o/r")).toEqual({ hits: [{ url: "https://github.example/o/r/pull/5#pullrequestreview-1", kind: "device-code", line: 2 }], scanned: 3 });
    expect(gh.calls.at(-1)).toMatchObject({ path: "repos/o/r/pulls/5/reviews?per_page=100&page=1" });
  });

  test("scanIssues retries a failed page and gives up with ScanFetchError", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const fail = () => { throw new GhError("HTTP 502"); };
    // the first try of the first page fails, the second answers: the hit is still found
    const gh = fakeGh([fail, () => [row(7, `コード ${code}`)], () => [], () => []]);
    expect(await scanIssues(gh, "o/r", sleep)).toEqual({ hits: [{ url: "https://github.example/o/r/issues/7", kind: "device-code", line: 1 }], scanned: 1 });
    expect(waits.length).toBe(1);
    // failing every time: three tries, then no answer at all
    const down = fakeGh([fail, fail, fail]);
    await expect(scanIssues(down, "o/r", sleep)).rejects.toBeInstanceOf(ScanFetchError);
    expect(down.calls.length).toBe(3);
    // a failure the client classified (a limit, an outage, auth) is not asked again, and the count says so (#894)
    const limited = fakeGh([() => { throw new GhError("secondary", "secondary"); }]);
    await expect(scanIssues(limited, "o/r", sleep)).rejects.toThrow("（1 回）");
    expect(limited.calls.length).toBe(1);
  });

  test("a list that cannot be read, or is not a list, is an error and not an empty result", async () => {
    await expect(scanIssues(fakeGh([() => { throw new GhError("HTTP 403"); }]), "o/r", async () => {})).rejects.toBeInstanceOf(ScanFetchError);
    await expect(scanIssues(fakeGh([() => ({ message: "Not Found" })]), "o/r")).rejects.toBeInstanceOf(ScanFetchError);
    await expect(scanIssues(fakeGh([() => [{ body: "x" }]]), "o/r")).rejects.toBeInstanceOf(ScanFetchError);
  });
});
