import { describe, expect, test } from "bun:test";
import { GetDistributionConfigCommand, UpdateDistributionCommand } from "@aws-sdk/client-cloudfront";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { MAX_ALLOWANCE_MS, makeCountries, parseAllowance, type Allowance } from "./countries.ts";

const H = 3600_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

/** Fake CloudFront (one whitelist), S3 (the one object) and SSM, and a clock that moves. */
function setup(o: { base?: string[]; whitelist?: string[]; saved?: Allowance } = {}) {
  let t = T0;
  let saved: Allowance | undefined = o.saved;
  let whitelist = o.whitelist ?? o.base ?? ["JP"];
  let version = 1;
  let failing = 0;
  let replacement: Allowance | undefined;
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const log = console.log;
  const c = makeCountries({
    base: o.base ?? ["JP"],
    bucket: "b",
    now: () => t,
    ssm: { send: async (cmd) => (cmd instanceof GetParameterCommand ? { Parameter: { Value: "EDIST" } } : {}) },
    cloudfront: {
      send: async (cmd) => {
        if (cmd instanceof GetDistributionConfigCommand) {
          calls.push("get");
          return { ETag: "e1", DistributionConfig: { Comment: "keep", Restrictions: { GeoRestriction: { RestrictionType: "whitelist", Quantity: whitelist.length, Items: whitelist } } } };
        }
        if (cmd instanceof UpdateDistributionCommand) {
          calls.push("update");
          if (failing > 0) throw (failing--, new Error("throttled"));
          if (replacement) (saved = replacement, version++, (replacement = undefined)); // someone saves a new allowance meanwhile
          expect(cmd.input.IfMatch).toBe("e1");
          expect((cmd.input.DistributionConfig as { Comment: string }).Comment).toBe("keep");
          whitelist = cmd.input.DistributionConfig!.Restrictions!.GeoRestriction!.Items!;
          return {};
        }
        throw new Error("unexpected");
      },
    },
    s3: {
      send: async (cmd) => {
        if (cmd instanceof GetObjectCommand) {
          if (!saved) throw Object.assign(new Error("no"), { name: "NoSuchKey" });
          return { ETag: `"${version}"`, Body: { transformToString: async () => JSON.stringify(saved) } };
        }
        if (cmd instanceof PutObjectCommand) return void ((saved = JSON.parse(String(cmd.input.Body))), version++);
        if (cmd instanceof DeleteObjectCommand) {
          if (cmd.input.IfMatch && cmd.input.IfMatch !== `"${version}"`) throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          return void (saved = undefined);
        }
        throw new Error("unexpected");
      },
    },
  });
  const capture = async <T>(f: () => Promise<T>) => {
    console.log = (l: string) => void logs.push(JSON.parse(l));
    try {
      return await f();
    } finally {
      console.log = log;
    }
  };
  return { failUpdates: (n: number) => (failing = n), replaceDuringUpdate: (a: Allowance) => (replacement = a), c, calls, logs, capture, advance: (ms: number) => (t += ms), whitelist: () => whitelist, saved: () => saved };
}
const window = (from = T0 + H, until = T0 + 48 * H): Allowance => ({ countries: ["US"], from, until, setAt: T0 });

describe("aws/countries.ts (#1639)", () => {
  test("parseAllowance refuses bad input", () => {
    const ok = { countries: ["us"], until: T0 + H };
    for (const bad of [
      { ...ok }, // lower case
      { countries: ["USA"], until: T0 + H },
      { countries: [], until: T0 + H },
      { countries: ["US"] }, // no end
      { countries: ["US"], until: T0 - 1 }, // past
      { countries: ["US"], from: T0 + 2 * H, until: T0 + H }, // end before start
      { countries: ["US"], until: T0 + MAX_ALLOWANCE_MS + H }, // over 90 days
      { countries: Array.from({ length: 11 }, (_, i) => "A" + String.fromCharCode(65 + i)), until: T0 + H },
      null,
    ]) expect("error" in parseAllowance(bad, T0)).toBe(true);
    expect(parseAllowance({ countries: ["US", "US", "GB"], until: T0 + H }, T0)).toEqual({ countries: ["GB", "US"], from: T0, until: T0 + H, setAt: T0 });
  });

  test("reconcile follows the window", async () => {
    const s = setup({ saved: window() });
    await s.capture(() => s.c.reconcile());
    expect(s.whitelist()).toEqual(["JP"]); // before the start: nothing to change
    expect(s.calls).toEqual(["get"]);
    s.advance(H + 60_000);
    await s.capture(() => s.c.reconcile());
    expect(s.whitelist()).toEqual(["JP", "US"]);
    s.advance(48 * H);
    const r = await s.capture(() => s.c.reconcile());
    expect(r).toBe("revert");
    expect(s.whitelist()).toEqual(["JP"]);
    expect(s.saved()).toBeUndefined();
    expect(s.logs.map((l) => l.action)).toEqual(["apply", "revert"]);
    expect(s.logs[0]).toMatchObject({ log: "countries", countries: ["US"], from: T0 + H, until: T0 + 48 * H });
  });

  test("reconcile restores after a redeploy", async () => {
    const s = setup({ saved: window(), whitelist: ["JP"] });
    s.advance(H + 60_000);
    await s.capture(() => s.c.reconcile());
    expect(s.whitelist()).toEqual(["JP", "US"]);
    s.whitelist().splice(0, 2, "JP"); // a redeploy right after: still inside the first minutes
    await s.capture(() => s.c.reconcile());
    expect(s.logs.map((l) => l.action)).toEqual(["apply", "restore"]);
    s.calls.length = 0;
    await s.capture(() => s.c.reconcile());
    expect(s.calls).toEqual(["get"]); // already right: no update
  });

  test("an allowance replaced while CloudFront already matches is marked too, so a later redeploy logs restore", async () => {
    const s = setup({ saved: window(T0, T0 + 48 * H), whitelist: ["JP", "US"] });
    s.advance(60_000);
    await s.capture(() => s.c.reconcile());
    expect(s.calls).toEqual(["get"]); // nothing to change in CloudFront
    expect(s.saved()?.applied).toBe(true);
  });

  test("reconcile does nothing without a base", async () => {
    const s = setup({ base: [], saved: window(T0, T0 + H) });
    await s.c.reconcile();
    expect(s.calls).toEqual([]);
    expect((await s.c.view()).base).toEqual([]);
  });

  test("no allowance, no CloudFront call", async () => {
    const s = setup();
    await s.c.reconcile();
    expect(s.calls).toEqual([]);
  });

  test("set applies at once and clear puts the base back", async () => {
    const s = setup();
    await s.capture(() => s.c.set({ countries: ["US"], from: T0, until: T0 + H, setAt: T0 }));
    expect(s.whitelist()).toEqual(["JP", "US"]);
    expect(await s.c.view()).toMatchObject({ base: ["JP"], active: true });
    await s.capture(() => s.c.clear());
    expect(s.whitelist()).toEqual(["JP"]);
    expect(s.saved()).toBeUndefined();
    expect(s.logs.map((l) => l.action)).toEqual(["set", "apply", "clear", "revert"]);
  });

  test("a failed revert after clear is finished by the next run (the record stays until CloudFront is back)", async () => {
    const s = setup({ saved: { countries: ["US"], from: T0, until: T0 + 48 * H, setAt: T0 }, whitelist: ["JP", "US"] });
    s.failUpdates(1);
    await expect(s.capture(() => s.c.clear())).rejects.toThrow();
    expect(s.whitelist()).toEqual(["JP", "US"]);
    expect(s.saved()).toBeDefined();
    expect((await s.c.view()).allowance).toBeNull(); // the page already shows it as ended
    s.advance(5 * 60_000);
    await s.capture(() => s.c.reconcile());
    expect(s.whitelist()).toEqual(["JP"]);
    expect(s.saved()).toBeUndefined();
  });

  test("an expired record's cleanup does not delete a newer allowance saved meanwhile", async () => {
    const s = setup({ saved: window(T0, T0 + H), whitelist: ["JP", "US"] });
    s.advance(2 * H);
    s.replaceDuringUpdate({ countries: ["GB"], from: T0, until: T0 + 90 * H, setAt: T0 });
    await s.capture(() => s.c.reconcile());
    expect(s.saved()?.countries).toEqual(["GB"]);
  });
});
