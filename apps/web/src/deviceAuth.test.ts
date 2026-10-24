import { describe, expect, test } from "bun:test";
import { hostOf, remaining, visible } from "./deviceAuth.ts";

const auth = { url: "https://device.login.example/activate?x=1", code: ["ABCD", "EFGH"].join("-"), command: "cloud login", expiresAt: 100_000 };

describe("device auth card (#676)", () => {
  test("time left as m:ss, rounded up; nothing once it has passed", () => {
    expect(remaining(100_000, 100_000 - 600_000)).toBe("10:00");
    expect(remaining(100_000, 100_000 - 61_500)).toBe("1:02");
    expect(remaining(100_000, 100_000 - 9_000)).toBe("0:09");
    expect(remaining(100_000, 99_999)).toBe("0:01");
    expect(remaining(100_000, 100_000)).toBe("");
    expect(remaining(100_000, 120_000)).toBe("");
  });

  test("shown until expiresAt, not at it or after; nothing without a wait", () => {
    expect(visible(auth, 99_999)).toBe(true);
    expect(visible(auth, 100_000)).toBe(false);
    expect(visible(auth, 100_001)).toBe(false);
    expect(visible(null, 0)).toBe(false);
    expect(visible(undefined, 0)).toBe(false);
  });

  test("the host of the URL, with its port; a broken URL as it is", () => {
    expect(hostOf(auth.url)).toBe("device.login.example");
    expect(hostOf("https://sso.example:8443/start")).toBe("sso.example:8443");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
