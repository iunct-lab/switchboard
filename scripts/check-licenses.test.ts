import { describe, expect, test } from "bun:test";
import { allowedExpression, check, validate, type AllowList, type LicenseReport } from "./check-licenses";

const allow: AllowList = { allowed: ["MIT", "Apache-2.0", "ISC"], exceptions: [] };
const pkg = (name: string, license: unknown, versions = ["1.0.0"]) => ({ name, versions, license });

describe("check-licenses", () => {
  test("allowed licenses pass; GPL-3.0 is one violation with name, version and license", () => {
    const report: LicenseReport = { MIT: [pkg("a", "MIT")], "GPL-3.0": [pkg("bad", "GPL-3.0", ["2.1.0"])] };
    expect(check(report, allow)).toEqual([{ name: "bad", version: "2.1.0", license: "GPL-3.0", why: "not in the allow list" }]);
  });

  test("an unknown, empty or UNLICENSED license is a violation", () => {
    const report: LicenseReport = { UNKNOWN: [pkg("u", undefined)], UNLICENSED: [pkg("p", "UNLICENSED")], "": [pkg("e", "")] };
    expect(check(report, allow).map((v) => [v.name, v.why])).toEqual([["u", "unknown license"], ["p", "unknown license"], ["e", "unknown license"]]);
  });

  test("SPDX: an OR passes when one choice is allowed, an AND needs all", () => {
    const allowed = new Set(allow.allowed);
    expect(allowedExpression("(MIT OR GPL-3.0)", allowed)).toBe(true);
    expect(allowedExpression("MIT AND GPL-3.0", allowed)).toBe(false);
    expect(allowedExpression("(MIT AND ISC)", allowed)).toBe(true);
    expect(allowedExpression("GPL-3.0 OR MIT AND ISC", allowed)).toBe(true);
    expect(check({ "(MIT OR GPL-3.0)": [pkg("dual", "(MIT OR GPL-3.0)")] }, allow)).toEqual([]);
  });

  test("SPDX: a parenthesised group joined to another part is not parsed and fails closed", () => {
    const allowed = new Set(allow.allowed);
    expect(allowedExpression("(MIT OR ISC) AND GPL-3.0", allowed)).toBe(false);
    expect(allowedExpression("GPL-3.0 AND (MIT OR ISC)", allowed)).toBe(false);
    expect(allowedExpression("(MIT OR Apache-2.0) AND (GPL-3.0 OR ISC)", allowed)).toBe(false);
    expect(allowedExpression("((MIT))", allowed)).toBe(false); // only one outer pair is taken off
    expect(check({ x: [pkg("mixed", "(MIT OR ISC) AND GPL-3.0")] }, allow)[0]!.why).toBe("SPDX expression with nested groups (not parsed)");
  });

  test("an exception holds until its date and fails again after it", () => {
    const withEx: AllowList = { ...allow, exceptions: [{ name: "bad", license: "GPL-3.0", reason: "build-time only, not shipped", until: "2026-12-31" }] };
    const report: LicenseReport = { "GPL-3.0": [pkg("bad", "GPL-3.0")] };
    expect(check(report, withEx, "2026-12-31")).toEqual([]);
    expect(check(report, withEx, "2027-01-01")).toEqual([{ name: "bad", version: "1.0.0", license: "GPL-3.0", why: "exception expired on 2026-12-31" }]);
    // an exception for another license of the same package does not cover it
    expect(check({ "AGPL-3.0": [pkg("bad", "AGPL-3.0")] }, withEx, "2026-01-01")).toHaveLength(1);
  });

  test("an exception without a reason or a date is a configuration error", () => {
    expect(() => validate({ ...allow, exceptions: [{ name: "bad", license: "GPL-3.0", reason: " ", until: "2026-12-31" }] })).toThrow("has no reason");
    expect(() => validate({ ...allow, exceptions: [{ name: "bad", license: "GPL-3.0", reason: "r", until: "soon" }] })).toThrow("until");
    expect(() => validate({ ...allow, exceptions: [{ name: "bad", license: "GPL-3.0", reason: "r", until: "2026-02-31" }] })).toThrow("a date that exists");
  });

  test("an allow list without its arrays is a readable configuration error", () => {
    expect(() => validate({ allowed: ["MIT"] } as unknown as AllowList)).toThrow('"exceptions" array');
    expect(() => validate({ exceptions: [] } as unknown as AllowList)).toThrow('"allowed" array');
  });

  test("a legacy { type } license object is read", () => {
    expect(check({ weird: [pkg("old", { type: "MIT" })] }, allow)).toEqual([]);
  });
});
