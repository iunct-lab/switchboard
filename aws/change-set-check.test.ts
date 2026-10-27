import { describe, expect, test } from "bun:test";
import { checkChangeSet, type ChangeSet } from "./change-set-check";

const change = (LogicalResourceId: string, Action: string, ResourceType = "AWS::EC2::Instance", Replacement?: string) => ({ ResourceChange: { Action, LogicalResourceId, ResourceType, ...(Replacement ? { Replacement } : {}) } });
const replace: ChangeSet["Changes"] = [change("LaunchTemplate", "Modify", "AWS::EC2::LaunchTemplate", "False"), change("Instance", "Modify", "AWS::EC2::Instance", "True")];
/** A new LaunchGeneration: new origins added, the old ones removed, the distribution moved. */
const bumped: ChangeSet = { Changes: [...replace!, change("HostVpcOrigin202610261200", "Add", "AWS::CloudFront::VpcOrigin"), change("RescueVpcOrigin202610261200", "Add", "AWS::CloudFront::VpcOrigin"), change("HostVpcOrigin4", "Remove", "AWS::CloudFront::VpcOrigin"), change("RescueVpcOrigin4", "Remove", "AWS::CloudFront::VpcOrigin"), change("Cdn", "Modify", "AWS::CloudFront::Distribution", "False")] };
/** The same launch template change without a new LaunchGeneration: the origins in use would be updated in place. */
const forgotten: ChangeSet = { Changes: [...replace!, change("HostVpcOrigin4", "Modify", "AWS::CloudFront::VpcOrigin", "False"), change("RescueVpcOrigin4", "Modify", "AWS::CloudFront::VpcOrigin", "False"), change("Cdn", "Modify", "AWS::CloudFront::Distribution", "False")] };

describe("checkChangeSet (#465)", () => {
  test("changes that leave the instance alone pass", () => {
    expect(checkChangeSet({ Changes: [change("Starter", "Modify", "AWS::Lambda::Function", "False"), change("Cdn", "Modify", "AWS::CloudFront::Distribution", "False")] })).toEqual({ ok: true });
  });

  test("a replacement with a new LaunchGeneration is a person's deploy: refused, unless --allow-replace", () => {
    const v = checkChangeSet(bumped);
    expect(v).toEqual({ ok: false, reason: expect.stringContaining("replaces the instance") });
    expect(checkChangeSet(bumped, { allowReplace: true })).toEqual({ ok: true });
  });

  test("a replacement that would modify a VPC origin in place names LaunchGeneration, even with --allow-replace", () => {
    for (const allowReplace of [false, true]) {
      const v = checkChangeSet(forgotten, { allowReplace });
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.reason).toContain("VPC origin HostVpcOrigin4 would be updated in place");
        expect(v.reason).toContain("LaunchGeneration=");
      }
    }
  });

  test("an empty change set (or none at all) passes", () => {
    expect(checkChangeSet({ Changes: [] })).toEqual({ ok: true });
    expect(checkChangeSet({})).toEqual({ ok: true });
  });
});

describe("bun aws/change-set-check.ts", () => {
  const run = (input: string, ...flags: string[]) => {
    const p = Bun.spawnSync(["bun", new URL("./change-set-check.ts", import.meta.url).pathname, ...flags], { stdin: new TextEncoder().encode(input) });
    return { code: p.exitCode, err: p.stderr.toString().trim() };
  };

  test("exit 1 with the reason on one line; 0 when it may run; 2 for input that is not a change set", () => {
    expect(run(JSON.stringify(forgotten))).toEqual({ code: 1, err: expect.stringContaining("LaunchGeneration=") });
    expect(run(JSON.stringify(forgotten)).err.split("\n")).toHaveLength(1);
    expect(run(JSON.stringify(bumped), "--allow-replace")).toEqual({ code: 0, err: "" });
    expect(run(JSON.stringify(bumped)).code).toBe(1);
    expect(run("not json").code).toBe(2);
    expect(run("{}", "--force").code).toBe(2);
  });
});
