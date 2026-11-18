import { expect, test } from "bun:test";
import { promote } from "./promote.ts";

const SHA = "a".repeat(40);

function fake(busy: { id: string; title: string; status: string }[], promoteStatus = 200, late?: { id: string; title: string; status: string }[], proof: () => Response = () => Response.json({ url: "u", token: "mcp_t1" })) {
  const posts: { url: string; body: any; auth: string | null; task: string | null; proof: string | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const h = new Headers(init.headers);
      posts.push({ url, body: JSON.parse(String(init.body)), auth: h.get("authorization"), task: h.get("x-task-id"), proof: h.get("x-task-token") });
      return new Response(JSON.stringify(promoteStatus === 200 ? { ok: true } : { error: "x", ...(late ? { busy: late } : {}) }), { status: promoteStatus });
    }
    if (url === "http://x/api/tasks/t1/mcp") return proof();
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
  // never `force`: the daemon counts the other Tasks again as it takes the request (all but the one that asks)
  // and never a Task named in the body: the Task left out of the count is the one the request proves it comes from
  expect(a.posts[0]!.body).toEqual({ commit: SHA });
  expect(a.posts[0]!).toMatchObject({ auth: "Bearer tok", task: "t1", proof: "mcp_t1" });

  // the proof cannot be read (the Task's endpoint is gone): not asked — the daemon would count this Task as busy
  a = fake([me], 200, undefined, () => Response.json({ error: "ended" }, { status: 409 }));
  r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(2);
  expect(r.out).toContain("口の鍵を読めない");
  expect(a.posts.length).toBe(0);

  a = fake([me, { id: "t2", title: "other", status: "waiting" }]);
  r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(1);
  expect(a.posts.length).toBe(0);
  expect(r.out).toContain("t2");

  a = fake([me], 409);
  r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(2);
  expect(r.out).toContain("409");

  // a Task that began between the list and the request: the daemon refuses and names it, and that is "others are there", not a failure
  a = fake([me], 409, [{ id: "t3", title: "late", status: "running" }]);
  r = await promote({ ...base, fetch: a.f });
  expect(r.code).toBe(1);
  expect(r.out).toContain("t3\tlate\trunning");

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
