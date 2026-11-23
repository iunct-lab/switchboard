// test-reads: none
import { describe, expect, test } from "bun:test";
import { loadUplink, parseMachines, UPLINK_PREVIEW } from "./config.ts";
import { decidesNothing, isMachineName, isWorkMachine, otherMachineOf, OtherMachineError, requireOwn, workMachineGh } from "./machine.ts";

describe("the two judgements of machines sharing work", () => {
  test("a Task belongs to another machine exactly when its record names one", () => {
    expect(otherMachineOf({ machine: "pc1" })).toBe("pc1");
    for (const own of [{}, { machine: null }, { machine: "" }, null, undefined]) expect(otherMachineOf(own)).toBeNull();
    expect(() => requireOwn({ machine: null })).not.toThrow();
    let e: unknown;
    try {
      requireOwn({ machine: "pc1" });
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(OtherMachineError);
    expect((e as OtherMachineError).status).toBe(409);
    expect((e as OtherMachineError).message).toBe("この Task は pc1 で動きました。返信は pc1 の Switchboard から行います。");
  });

  test("a work machine is the daemon started as `send`; a candidate never is, and both decide nothing by themselves", () => {
    const cfg = (mode: "send" | "receive" | null, candidate = false) => ({ uplink: { mode }, candidate });
    expect([isWorkMachine(cfg("send")), isWorkMachine(cfg("receive")), isWorkMachine(cfg(null)), isWorkMachine(cfg("send", true))]).toEqual([true, false, false, false]);
    expect([decidesNothing(cfg("send")), decidesNothing(cfg("receive")), decidesNothing(cfg(null)), decidesNothing(cfg(null, true))]).toEqual([true, false, false, true]);
  });

  test("a machine's name is one plain segment: never `.`, `..`, a path or a pattern", () => {
    for (const ok of ["pc1", "PC-2", "a_b", "9"]) expect([ok, isMachineName(ok)]).toEqual([ok, true]);
    for (const bad of ["", ".", "..", "../x", "a/b", "a.b", "-x", "_x", "a b", "a%", "a*", "x".repeat(64), 5, null]) expect([bad, isMachineName(bad)]).toEqual([bad, false]);
  });

  test("the daemon's gh on a work machine lets only reads through: a write is not run and answers as a failed call", async () => {
    const ran: string[][] = [];
    const refused: string[][] = [];
    const gh = workMachineGh(async (args) => (ran.push(args), { code: 0, stdout: "ok", stderr: "" }), (args) => refused.push(args));
    expect((await gh(["pr", "view", "5"], "/x")).stdout).toBe("ok");
    expect((await gh(["api", "graphql", "-f", "query=query{viewer{login}}"], "/x")).code).toBe(0);
    for (const write of [["pr", "create"], ["pr", "comment", "5", "-b", "[local-ci] pass"], ["pr", "merge", "5"], ["issue", "create"], ["api", "graphql", "-f", "query=mutation{x}"], ["api", "-X", "PUT", "repos/o/r/contents/x"], ["repo", "create", "x"], ["release", "create", "v1"]]) {
      const r = await gh(write, "/x");
      expect([write.join(" "), r.code]).toEqual([write.join(" "), 1]);
      expect(r.stderr).toContain("作業場のマシンでは行いません");
    }
    expect(ran).toEqual([["pr", "view", "5"], ["api", "graphql", "-f", "query=query{viewer{login}}"]]);
    expect(refused).toHaveLength(8);
  });
});

describe("the settings", () => {
  test("with nothing set there is no mode, no machine and no registry: the feature is off", () => {
    expect(loadUplink({})).toMatchObject({ mode: null, machine: "", machines: {}, bucket: "" });
    // the registry alone turns nothing on, and a work machine has none
    expect(loadUplink({ SWITCHBOARD_UPLINK_MACHINES: "pc1=acme/app" })).toMatchObject({ mode: null, machines: {} });
    expect(loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b", SWITCHBOARD_UPLINK_MACHINES: "pc2=acme/app" }).machines).toEqual({});
    // the instance takes in from nobody until a machine is registered
    expect(loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive" }).machines).toEqual({});
  });

  test("the registry names each work machine once with its repositories; anything else stops the start", () => {
    expect(parseMachines("pc1=Acme/App+acme/tools, pc2=acme/app", "instance")).toEqual({ pc1: ["acme/app", "acme/tools"], pc2: ["acme/app"] });
    expect(parseMachines("", "instance")).toEqual({});
    for (const bad of ["pc1", "pc1=", "pc1=acme", "..=acme/app", "pc1=acme/app,pc1=acme/b", "instance=acme/app", "pc1=acme/app=x", "pc/1=acme/app", "pc1=../x", "pc1=acme/app+"]) expect(() => parseMachines(bad, "instance")).toThrow("SWITCHBOARD_UPLINK_MACHINES");
    expect(() => loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "..", SWITCHBOARD_UPLINK_BUCKET: "b" })).toThrow("SWITCHBOARD_MACHINE");
    expect(() => loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "a.b", SWITCHBOARD_UPLINK_BUCKET: "b" })).toThrow("SWITCHBOARD_MACHINE");
  });
});
