import { expect, test } from "bun:test";
import { promote } from "./promote.ts";

const SHA = "a".repeat(40);

function fake(busy: { id: string; title: string; status: string }[], promoteStatus = 200) {
  const posts: { url: string; body: any; auth: string | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify(promoteStatus === 200 ? { ok: true } : { error: "x" }), { status: promoteStatus });
    }
    return new Response(JSON.stringify({ ok: true, busyTasks: busy }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, posts };
}
const me = { id: "t1", title: "me", status: "running" };
const base = { commit: "origin/main", taskId: "t1", base: "http://x", token: "tok", resolve: async () => SHA };

test("promotes only when no other task is busy", async () => {
  let a = fake([me]);
  let r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(0);
  expect(a.posts.length).toBe(1);
  expect(a.posts[0]!.url).toBe("http://x/api/daemon/promote");
  expect(a.posts[0]!.body).toEqual({ commit: SHA, force: true });
  expect(a.posts[0]!.auth).toBe("Bearer tok");

  a = fake([me, { id: "t2", title: "other", status: "waiting" }]);
  r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(1);
  expect(a.posts.length).toBe(0);
  expect(r.out).toContain("t2");

  a = fake([me], 409);
  r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(2);
  expect(r.out).toContain("409");

  a = fake([]);
  r = await promote({ ...base, fetch: a.f, resolve: async () => { throw new Error("bad rev"); } });
  expect(r.code).toBe(2);
  expect(a.posts.length).toBe(0);

  // Task の外: 自分を除かずに数える
  a = fake([me]);
  r = await promote({ ...base, taskId: undefined, fetch: a.f });
  expect(r.code).toBe(1);
  expect(a.posts.length).toBe(0);

  // 一覧が無い・health が非 2xx・届かない: 頼まずに 2
  const posted: string[] = [];
  const health = (res: () => Response) => (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(url);
    return res();
  }) as unknown as typeof fetch;
  r = await promote({ ...base, fetch: health(() => new Response(JSON.stringify({ ok: true }), { status: 200 })) });
  expect(r.code).toBe(2);
  r = await promote({ ...base, fetch: health(() => new Response("no", { status: 500 })) });
  expect(r.code).toBe(2);
  r = await promote({ ...base, fetch: health(() => { throw new Error("ECONNREFUSED"); }) });
  expect(r.code).toBe(2);
  expect(r.out).toContain("届かない");
  expect(posted).toEqual([]);
});
