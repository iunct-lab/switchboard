import { expect, test } from "bun:test";
import { bundle } from "./bundle.ts";

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const base = { base: "http://127.0.0.1:1", token: "tok" };

test("release calls DELETE /api/bundle with the key and says how many schedules came back", async () => {
  const seen: Array<[string, string | undefined, string | null]> = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push([url, init?.method, new Headers(init?.headers).get("authorization")]);
    return new Response(JSON.stringify({ released: true, restored: ["a", "b"] }));
  }) as unknown as typeof fetch;
  expect(await bundle({ cmd: "release", ...base, fetch: f })).toEqual({ code: 0, out: "止めを解いた。戻した定期実行 2 件" });
  expect(seen).toEqual([["http://127.0.0.1:1/api/bundle", "DELETE", "Bearer tok"]]);
});

test("release with no hold exits 0 and says so; an unreachable daemon or a refusal is exit 2", async () => {
  expect(await bundle({ cmd: "release", ...base, fetch: reply(200, { released: false, restored: [] }) })).toEqual({ code: 0, out: "止めはありません" });
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect((await bundle({ cmd: "release", ...base, fetch: down })).code).toBe(2);
  expect((await bundle({ cmd: "release", ...base, fetch: reply(401, { error: "no" }) })).code).toBe(2);
  expect((await bundle({ cmd: "other", ...base, fetch: down })).code).toBe(2);
});

test("status prints the hold in one line, or that there is none", async () => {
  const r = await bundle({ cmd: "status", ...base, fetch: reply(200, { taskId: "tsk_1", since: 0, schedules: ["a"], base: null }) });
  expect(r.code).toBe(0);
  expect(r.out).toBe("止め中: Task tsk_1、1970-01-01T00:00:00.000Z から、止めた定期実行 1 件");
  expect(await bundle({ cmd: "status", ...base, fetch: reply(200, null) })).toEqual({ code: 0, out: "止めはありません" });
});
