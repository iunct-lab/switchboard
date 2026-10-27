import { describe, expect, test } from "bun:test";
import { ACTIONS, hostEnv, parseArgs, planHostOperation, runHostOperation, type Deps } from "./host-ops";

const e = { stack: "switchboard-host", region: "ap-northeast-1", params: "ImageId=ami-0 VpcId=vpc-0" };
const TOKEN = "start-token-value";
const EDGE = "edge-header-value";
const changeSet = "Changeset created successfully. Run the following command to review changes:\naws cloudformation describe-change-set --change-set-name arn:aws:cloudformation:ap-northeast-1:111111111111:changeSet/awscli-cloudformation-package-deploy-1/abc";

/** A fake AWS CLI / bun: answers by command prefix (the first match), records every call and every log line. */
function fake(answers: Array<[string, { ok?: boolean; out?: string; err?: string }]> = []) {
  const calls: string[] = [];
  const posts: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const base: Array<[string, { ok?: boolean; out?: string; err?: string }]> = [
    ...answers,
    ["aws ssm get-parameter --name /switchboard/start-token", { out: `${TOKEN}\n` }],
    ["aws ssm get-parameter --name /switchboard/edge-header", { out: `${EDGE}\n` }],
    ["aws cloudformation describe-stacks", { out: "https://starter.example/\n" }],
    ["aws ec2 describe-instances", { out: "running\n" }],
    ["aws cloudformation deploy", { out: `Waiting for changeset to be created..\nEdgeHeaderValue=${EDGE}\n${changeSet}\n` }],
    ["aws cloudformation describe-change-set", { out: '{"Changes":[]}\n' }],
  ];
  const d: Deps = {
    run: (cmd) => {
      const c = cmd.join(" ");
      calls.push(c);
      const a = base.find(([k]) => c.startsWith(k))?.[1] ?? {};
      return { ok: a.ok ?? true, out: a.out ?? "", err: a.err ?? "" };
    },
    post: async (url, headers) => {
      posts.push({ url, headers });
      return { status: 200, text: `{"state":"pending","echo":"${TOKEN}"}` };
    },
    log: (s) => logs.push(s),
  };
  return { d, calls, posts, logs };
}

describe("host-ops plan and arguments", () => {
  test("--dry-run plans every action and calls nothing: no AWS, no secret", () => {
    for (const a of ACTIONS) {
      const plan = planHostOperation(a, e).join("\n");
      expect(plan).toContain("switchboard-host");
      expect(plan).not.toContain(TOKEN);
    }
    expect(planHostOperation("deploy", { ...e, params: undefined }).join("\n")).toContain("未設定なので止まる");
    expect(parseArgs(["deploy", "--dry-run"])).toEqual({ action: "deploy", dryRun: true });
  });

  test("start / rebuild / deploy need --yes (or --dry-run); status does not; anything else is refused", () => {
    expect(parseArgs(["status"])).toEqual({ action: "status", dryRun: false });
    expect(parseArgs(["start"])).toBeNull();
    expect(parseArgs(["rebuild", "--yes"])).toEqual({ action: "rebuild", dryRun: false });
    expect(parseArgs(["deploy"])).toBeNull();
    expect(parseArgs(["stop", "--yes"])).toBeNull();
    expect(parseArgs(["status", "start"])).toBeNull();
    expect(parseArgs(["status", "--force"])).toBeNull();
  });

  test("stack, region and parameters come from the environment, with the workflow's defaults", () => {
    expect(hostEnv({})).toEqual({ stack: "switchboard-host", region: "ap-northeast-1", params: undefined });
    expect(hostEnv({ SWITCHBOARD_HOST_STACK: "s", SWITCHBOARD_AWS_REGION: "us-east-1", SWITCHBOARD_HOST_PARAMS: "A=1" })).toEqual({ stack: "s", region: "us-east-1", params: "A=1" });
  });
});

describe("host-ops run", () => {
  test("no AWS login: said as such before any step; nothing else runs", async () => {
    const f = fake([["aws sts get-caller-identity", { ok: false, err: "Unable to locate credentials" }]]);
    await expect(runHostOperation("start", e, f.d)).rejects.toThrow(/AWS に認証できない/);
    expect(f.calls).toHaveLength(1);
    expect(f.posts).toHaveLength(0);
  });

  test("status reads the instance's state and no secret", async () => {
    const f = fake();
    expect(await runHostOperation("status", e, f.d)).toBe("running");
    expect(f.calls.some((c) => c.includes("ssm get-parameter"))).toBe(false);
    expect(f.calls.every((c) => !c.startsWith("aws ") || c.endsWith("--region ap-northeast-1"))).toBe(true);
  });

  test("start / rebuild POST to the Starter with the token and the edge header in headers, never in a command or the output", async () => {
    for (const a of ["start", "rebuild"] as const) {
      const f = fake();
      const out = await runHostOperation(a, e, f.d);
      expect(f.posts).toEqual([{ url: `https://starter.example/${a}`, headers: { "x-switchboard-start-token": TOKEN, "x-switchboard-edge": EDGE } }]);
      expect(out).not.toContain(TOKEN);
      expect(f.calls.join("\n")).not.toContain(TOKEN);
    }
  });

  test("deploy without SWITCHBOARD_HOST_PARAMS stops before anything runs", async () => {
    const f = fake();
    await expect(runHostOperation("deploy", { ...e, params: undefined }, f.d)).rejects.toThrow(/SWITCHBOARD_HOST_PARAMS/);
    expect(f.calls).toHaveLength(0);
  });

  test("a failed deploy is a failure, not 'no changes' (#759)", async () => {
    const f = fake([["aws cloudformation deploy", { ok: false, err: "An error occurred (AccessDenied): is not authorized to perform: cloudformation:CreateChangeSet" }]]);
    await expect(runHostOperation("deploy", e, f.d)).rejects.toThrow("failed: aws cloudformation deploy");
    expect(f.logs.join("\n")).toContain("is not authorized to perform");
    expect(f.calls.some((c) => c.includes("execute-change-set"))).toBe(false);
  });

  test("an empty change set ends with 'no changes' (#759)", async () => {
    const f = fake([["aws cloudformation deploy", { out: "Waiting for changeset to be created..\n\nNo changes to deploy. Stack switchboard-host is up to date\n" }]]);
    expect(await runHostOperation("deploy", e, f.d)).toBe("no changes");
    expect(f.calls.some((c) => c.includes("describe-change-set"))).toBe(false);
  });

  test("a change set that touches the Instance or the LaunchTemplate is not executed, and says why (#465)", async () => {
    const vpc = (id: string, Action: string) => ({ ResourceChange: { Action, LogicalResourceId: id, ResourceType: "AWS::CloudFront::VpcOrigin" } });
    const instance = { ResourceChange: { Action: "Modify", LogicalResourceId: "Instance", ResourceType: "AWS::EC2::Instance", Replacement: "True" } };
    const cases = [
      [{ Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "LaunchTemplate" } }] }, "replaces the instance"],
      [{ Changes: [instance, vpc("HostVpcOrigin5", "Add"), vpc("HostVpcOrigin4", "Remove")] }, "replaces the instance"],
      [{ Changes: [instance, vpc("HostVpcOrigin4", "Modify")] }, "LaunchGeneration="],
    ] as const;
    for (const [cs, reason] of cases) {
      const f = fake([["aws cloudformation describe-change-set", { out: JSON.stringify(cs) }]]);
      await expect(runHostOperation("deploy", e, f.d)).rejects.toThrow(reason);
      expect(f.calls.find((c) => c.startsWith("aws cloudformation describe-change-set"))).toContain("--output json");
      expect(f.calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    }
  });

  test("a failed describe-change-set stops before executing", async () => {
    const f = fake([["aws cloudformation describe-change-set", { ok: false }]]);
    await expect(runHostOperation("deploy", e, f.d)).rejects.toThrow(/describe-change-set/);
    expect(f.calls.some((c) => c.includes("execute-change-set"))).toBe(false);
  });

  test("a change set that leaves the instance alone runs as DeployRole and is waited for; the edge header never reaches the log", async () => {
    const f = fake([["aws cloudformation describe-stacks --stack-name switchboard-host --query Stacks[0].Outputs[?OutputKey=='DeployRoleArn']", { out: "arn:role\n" }]]);
    expect(await runHostOperation("deploy", e, f.d)).toBe(`executed ${changeSet.split(" ").at(-1)}`);
    const deploy = f.calls.find((c) => c.startsWith("aws cloudformation deploy"))!;
    expect(deploy).toContain("--role-arn arn:role");
    expect(deploy).toContain("--no-execute-changeset");
    expect(deploy).toContain("--parameter-overrides ImageId=ami-0 VpcId=vpc-0 EdgeHeaderValue=");
    expect(f.calls.at(-2)).toStartWith("aws cloudformation execute-change-set");
    expect(f.calls.at(-1)).toStartWith("aws cloudformation wait stack-update-complete");
    expect(f.logs.join("\n")).not.toContain(EDGE);
    expect(f.logs.join("\n")).toContain("EdgeHeaderValue=***");
  });

  test("deploy packages with the AWS CLI, not sam (sam cannot read Fn::ForEach, #465), and allows the LanguageExtensions transform", async () => {
    const f = fake();
    await runHostOperation("deploy", e, f.d);
    expect(f.calls.some((c) => c.startsWith("sam "))).toBe(false);
    const pkg = f.calls.findIndex((c) => c.startsWith("aws cloudformation package --template-file aws/template.yaml"));
    const deploy = f.calls.findIndex((c) => c.startsWith("aws cloudformation deploy --template-file dist/template.packaged.yaml"));
    expect(pkg).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(pkg);
    expect(f.calls[pkg]).toContain("--output-template-file dist/template.packaged.yaml");
    expect(f.calls[deploy]).toContain("CAPABILITY_AUTO_EXPAND");
  });
});

test("the host workflow runs this entry after OIDC, with --yes, and nothing of its own", async () => {
  const wf = await Bun.file(new URL("../.github/workflows/host.yml", import.meta.url)).text();
  expect(wf).toContain('bun scripts/host-ops.ts "$ACTION" --yes');
  expect(wf.indexOf("configure-aws-credentials")).toBeLessThan(wf.indexOf("run: bun scripts/host-ops.ts"));
  for (const gone of ["sam deploy", "ssm get-parameter", "curl"]) expect(wf).not.toContain(gone);
});
