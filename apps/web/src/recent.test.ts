import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "./api.ts";
import { RECENT_MESSAGE, askRecentCheck, isRecentRefusal, onRecentCheck } from "./recent.ts";

const realFetch = globalThis.fetch;
const realLocation = (globalThis as { location?: unknown }).location;
let calls = 0;
let assigned = 0;
let off = () => {};

const recent = () => new Response(JSON.stringify({ error: RECENT_MESSAGE, reason: "recent" }), { status: 401, headers: { "content-type": "application/json" } });
const ok = () => new Response(JSON.stringify({ saved: true }), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = 0;
  assigned = 0;
  (globalThis as { location?: unknown }).location = { pathname: "/", search: "", assign: () => { assigned++; }, replace: () => {} };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { location?: unknown }).location = realLocation;
  off();
  off = () => {};
});

const update = () => api.updateSettings({} as never);

test("a 401 recent is sent again once after the person checks", async () => {
  globalThis.fetch = (async () => (++calls === 1 ? recent() : ok())) as typeof fetch;
  off = onRecentCheck((resolve) => resolve(true));
  expect(await update()).toEqual({ saved: true } as never);
  expect(calls).toBe(2);
});

test("two 401 recent in a row end as the message, not a loop", async () => {
  globalThis.fetch = (async () => { calls++; return recent(); }) as typeof fetch;
  off = onRecentCheck((resolve) => resolve(true));
  await expect(update()).rejects.toThrow(RECENT_MESSAGE);
  expect(calls).toBe(2);
});

test("declining sends nothing again and does not go to the login page", async () => {
  globalThis.fetch = (async () => { calls++; return recent(); }) as typeof fetch;
  off = onRecentCheck((resolve) => resolve(false));
  await expect(update()).rejects.toThrow(RECENT_MESSAGE);
  expect(calls).toBe(1);
  expect(assigned).toBe(0);
});

test("requests that fail together share one question", async () => {
  let asked = 0;
  const first: Array<(ok: boolean) => void> = [];
  globalThis.fetch = (async () => { calls++; return calls <= 2 ? recent() : ok(); }) as typeof fetch;
  off = onRecentCheck((resolve) => { asked++; first.push(resolve); });
  const both = Promise.all([update(), update()]);
  await new Promise((r) => setTimeout(r, 20));
  expect(asked).toBe(1);
  first[0]!(true);
  await both;
  expect(calls).toBe(4);
});

test("with no screen listening the question is answered no", async () => {
  expect(await askRecentCheck()).toBe(false);
});

test("isRecentRefusal: only a 401 with reason recent", () => {
  expect(isRecentRefusal(401, { reason: "recent" })).toBe(true);
  expect(isRecentRefusal(401, {})).toBe(false);
  expect(isRecentRefusal(401, null)).toBe(false);
  expect(isRecentRefusal(403, { reason: "recent" })).toBe(false);
});
