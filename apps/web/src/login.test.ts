import { describe, expect, test } from "bun:test";
import { countriesUrl, hasTypedText, hostStopped, loginRoute, STUCK_RESCUE, stoppedRoute, withoutFromAuth } from "./login.ts";

describe("login route (#211)", () => {
  test("the daemon's login mode decides: passkey goes to /_auth/ with the way back, token asks for the token", () => {
    expect(loginRoute({ authorized: false, hasToken: false, mode: "passkey", path: "/approvals?x=1" })).toEqual({ kind: "passkey", url: "/_auth/?next=%2Fapprovals%3Fx%3D1" });
    expect(loginRoute({ authorized: false, hasToken: true, mode: "passkey", path: "/" })).toEqual({ kind: "passkey", url: "/_auth/?next=%2F" }); // a stale token does not help there
    expect(loginRoute({ authorized: false, hasToken: false, mode: "token", path: "/" })).toEqual({ kind: "token" });
    expect(loginRoute({ authorized: false, hasToken: false, mode: undefined, path: "/" })).toEqual({ kind: "token" }); // an older daemon
    expect(loginRoute({ authorized: false, hasToken: true, mode: "token", path: "/" })).toEqual({ kind: "none" });
    expect(loginRoute({ authorized: true, hasToken: false, mode: "passkey", path: "/" })).toEqual({ kind: "none" }); // the cookie worked
  });

  test("back from the passkey page and still refused: stuck, not another redirect (no loop)", () => {
    expect(loginRoute({ authorized: false, hasToken: false, mode: "passkey", path: "/?from=auth" })).toEqual({ kind: "stuck" });
    expect(loginRoute({ authorized: true, hasToken: false, mode: "passkey", path: "/?from=auth" })).toEqual({ kind: "none" });
  });

  test("once in, the passkey page's mark is dropped, so a later refusal goes back to the passkey page (#709)", () => {
    expect(withoutFromAuth("/?from=auth")).toBe("/");
    expect(withoutFromAuth("/approvals?x=1&from=auth")).toBe("/approvals?x=1");
    expect(withoutFromAuth("/approvals?x=1")).toBeNull();
    expect(withoutFromAuth("/?from=elsewhere")).toBeNull();
    // the tab that was let in, then had its passkey removed: with the mark gone it is sent to log in, not shown "stuck"
    expect(loginRoute({ authorized: false, hasToken: false, mode: "passkey", path: withoutFromAuth("/?from=auth")! })).toEqual({ kind: "passkey", url: "/_auth/?next=%2F" });
  });

  test("next never points off the origin", () => {
    expect(loginRoute({ authorized: false, hasToken: false, mode: "passkey", path: "//evil.example/" })).toEqual({ kind: "passkey", url: "/_auth/?next=%2F" });
  });
});

test("stoppedRoute: CloudFront's HTML 503 means the cloud host is off → the login page; a daemon's JSON errors never", () => {
  expect(stoppedRoute({ status: 503, contentType: "text/html; charset=utf-8", path: "/approvals" })).toBe("/_auth/?next=%2Fapprovals");
  expect(stoppedRoute({ status: 502, contentType: "text/html", path: "//evil.example" })).toBe("/_auth/?next=%2F");
  expect(stoppedRoute({ status: 503, contentType: "application/json", path: "/" })).toBeNull();
  expect(stoppedRoute({ status: 500, contentType: "text/html", path: "/" })).toBeNull();
  expect(stoppedRoute({ status: 401, contentType: "application/json", path: "/" })).toBeNull();
  expect(stoppedRoute({ status: 424, contentType: "application/json", path: "/" })).toBeNull(); // the daemon's "GitHub / sb-rescue failed" (#364)
});

test("stuck links to the same origin's rescue page (#399), which the service worker leaves to the server", async () => {
  expect(STUCK_RESCUE).toBe("/rescue/");
  const sw = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();
  expect(new RegExp(sw.match(/const LIVE = \/(.+)\/;/)![1]!).test(STUCK_RESCUE)).toBe(true);
});

describe("countries entry (#1639)", () => {
  test("countriesUrl is only for the passkey login (#1639)", () => {
    expect(countriesUrl("passkey")).toBe("/_auth/#countries");
    expect(countriesUrl("token")).toBeNull();
    expect(countriesUrl(undefined)).toBeNull();
  });
});

describe("hostStopped: one CloudFront error page is not the host being off", () => {
  const page = (status: number, type: string) => ({ status, headers: { get: (n: string) => (n === "content-type" ? type : null) } });
  const seq = (...answers: (ReturnType<typeof page> | Error)[]) => {
    let i = 0;
    const probe = async () => {
      const a = answers[i++];
      if (a instanceof Error) throw a;
      return a;
    };
    return Object.assign(probe, { calls: () => i });
  };

  test("the daemon answers /api/health → stay on the screen (a dropped connection, not a stopped host)", async () => {
    const probe = seq(page(200, "application/json"));
    expect(await hostStopped(probe, 2, 0)).toBe(false);
    expect(probe.calls()).toBe(1);
  });

  test("the stopped page once, then the daemon → stay", async () => {
    expect(await hostStopped(seq(page(503, "text/html"), page(200, "application/json")), 2, 0)).toBe(false);
  });

  test("the stopped page every time → off", async () => {
    expect(await hostStopped(seq(page(503, "text/html"), page(503, "text/html")), 2, 0)).toBe(true);
  });

  test("no answer at all (offline) → not off", async () => {
    expect(await hostStopped(seq(new Error("offline")), 2, 0)).toBe(false);
  });

  test("requests that fail together share one check", async () => {
    const probe = seq(page(503, "text/html"), page(503, "text/html"));
    const [a, b] = await Promise.all([hostStopped(probe, 2, 0), hostStopped(probe, 2, 0)]);
    expect([a, b]).toEqual([true, true]);
    expect(probe.calls()).toBe(2);
  });
});

test("hasTypedText: a non-blank text field is typed text; empty and blank ones are not", () => {
  const doc = (...values: string[]) => ({ querySelectorAll: () => values.map((value) => ({ value })) });
  expect(hasTypedText(doc())).toBe(false);
  expect(hasTypedText(doc("", "  \n"))).toBe(false);
  expect(hasTypedText(doc("", "draft"))).toBe(true);
});
