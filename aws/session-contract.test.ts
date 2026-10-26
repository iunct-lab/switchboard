import { expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { publicKeyOf, SESSION_IDLE_MS as AWS_IDLE, SESSION_MAX_MS as AWS_MAX, sessionOf, sessionValue } from "./auth.ts";
import { SESSION_IDLE_MS as CORE_IDLE, SESSION_MAX_MS as CORE_MAX, sessionOk } from "../packages/core/src/auth.ts";
import { SESSION_IDLE_MS as RESCUE_IDLE, SESSION_MAX_MS as RESCUE_MAX, recentCookieOk } from "../rescue/src/server.ts";

// The Lambda, the daemon and sb-rescue each judge sb_session on their own (sb-rescue shares no code, #178): this pins
// that they read the same cookie the same way (#498).
const SEED = "a".repeat(64);
const PUB = publicKeyOf(SEED);
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED, "hex")]), format: "der", type: "pkcs8" });

test("the three places use the same limits: 7 days, 24 hours idle", () => {
  expect([AWS_MAX, CORE_MAX, RESCUE_MAX]).toEqual([7 * 24 * 3600_000, 7 * 24 * 3600_000, 7 * 24 * 3600_000]);
  expect([AWS_IDLE, CORE_IDLE, RESCUE_IDLE]).toEqual([24 * 3600_000, 24 * 3600_000, 24 * 3600_000]);
});

test("the three places agree on every edge of the idle time, the cap and the old form", () => {
  const T = 1_800_000_000_000;
  const cases: [string, string, number, number][] = [
    ["both in the future", "pk1", T + 2, T + 3],
    ["idle time one ms ahead", "pk1", T + 1, T + 3],
    ["idle time at now", "pk1", T, T + 3],
    ["cap one ms ahead", "pk1", T + 1, T + 1],
    ["cap at now", "pk1", T + 2, T],
    ["idle time past the cap", "pk1", T + 5, T + 3],
  ];
  const check = (value: string, now: number) => {
    const req = new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${value}` } });
    const answers = [sessionOf(PUB, value, now) !== undefined, sessionOk(req, PUB, now)];
    // sb-rescue's session check is private; ask it through a session paired with a recent cookie of the same passkey
    answers.push(recentCookieOk(new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${value}; sb_recent=${recentFor(value)}` } }), PUB, now));
    return answers;
  };
  const recentFor = (value: string) => {
    const id = Buffer.from(value.split(".")[0]!, "base64url").toString().split(".")[0]!;
    const body = Buffer.from(`${id}.${T + 100}`).toString("base64url");
    return `${body}.${sign(null, Buffer.from("recent:" + body), privateKey).toString("base64url")}`;
  };
  for (const [name, id, idle, cap] of cases) {
    for (const now of [T, T + 1, T + 2, T + 3]) {
      const a = check(sessionValue(SEED, id, idle, cap), now);
      expect(new Set(a).size, `${name} at ${now - T}: ${a}`).toBe(1);
      expect(a[0], `${name} at ${now - T}`).toBe(idle > now && cap > now && idle <= cap);
    }
  }
  // the old two-field body
  const body = Buffer.from(`pk1.${T + 5}`).toString("base64url");
  const old = `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
  expect(check(old, T)).toEqual([false, false, false]);
});


test("a cookie the Starter renews passes the daemon and sb-rescue as well, with the cap it had (#498)", () => {
  const T = 1_800_000_000_000;
  const renewed = sessionValue(SEED, "pk1", T + AWS_IDLE, T + AWS_MAX - 1000); // what /_auth/renew makes late in a login
  const req = new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${renewed}` } });
  expect(sessionOf(PUB, renewed, T + 5)).toBe("pk1");
  expect(sessionOk(req, PUB, T + 5)).toBe(true);
  expect(sessionOk(req, PUB, T + AWS_MAX - 1000)).toBe(false);
});
