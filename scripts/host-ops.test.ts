// test-reads: .github/workflows/host.yml
import { describe, expect, test } from "bun:test";
import { ACTIONS, hostEnv, parseArgs, planHostOperation, runHostOperation, type Deps } from "./host-ops";

const e = { stack: "switchboard-host", region: "ap-northeast-1", params: "ImageId=ami-0 VpcId=vpc-0", personStack: "switchboard-host-person-deploy", driftTimeoutSeconds: 300, driftPollSeconds: 5 };
const TOKEN = "start-token-value";
const EDGE = "edge-header-value";
const changeSet = "Changeset created successfully. Run the following command to review changes:\naws cloudformation describe-change-set --change-set-name arn:aws:cloudformation:ap-northeast-1:123456789012:changeSet/awscli-cloudformation-package-deploy-1/abc";

/** A fake AWS CLI / bun: answers by command prefix (the first match), records every call and every log line. */
function fake(answers: Array<[string, { ok?: boolean; out?: string; err?: string }]> = []) {
  const calls: string[] = [];
  const posts: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const base: Array<[string, { ok?: boolean; out?: string; err?: string }]> = [
    ...answers,
    ["aws ssm get-parameter --name /switchboard/start-token", { out: `${TOKEN}\n` }],
    ["aws ssm get-parameter --name /switchboard/edge-header", { out: `${EDGE}\n` }],
    ["aws cloudformation describe-stacks --stack-name switchboard-host-person-deploy --query Stacks[0].Outputs[?OutputKey=='PersonDeployRoleArn']", { out: "arn:person-role\n" }],
    ["aws cloudformation describe-stacks --stack-name switchboard-host-person-deploy --query Stacks[0].Outputs[?OutputKey=='PersonDeployRoleName']", { out: "switchboard-host-person-deploy\n" }],
    ["aws cloudformation describe-stacks", { out: "https://starter.example/\n" }],
    ["aws iam list-attached-role-policies", { out: "\n" }],
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
    expect(parseArgs(["deploy", "--dry-run"])).toEqual({ action: "deploy", dryRun: true, allowReplace: false });
  });

  test("start / rebuild / deploy / person-deploy need --yes (or --dry-run); status does not; anything else is refused", () => {
    expect(parseArgs(["status"])).toEqual({ action: "status", dryRun: false, allowReplace: false });
    expect(parseArgs(["start"])).toBeNull();
    expect(parseArgs(["rebuild", "--yes"])).toEqual({ action: "rebuild", dryRun: false, allowReplace: false });
    expect(parseArgs(["deploy"])).toBeNull();
    expect(parseArgs(["stop", "--yes"])).toBeNull();
    expect(parseArgs(["status", "start"])).toBeNull();
    expect(parseArgs(["status", "--force"])).toBeNull();
  });

  test("stack, region and parameters come from the environment, with the workflow's defaults", () => {
    expect(hostEnv({})).toEqual({ stack: "switchboard-host", region: "ap-northeast-1", params: undefined, personStack: "switchboard-host-person-deploy", driftTimeoutSeconds: 300, driftPollSeconds: 5 });
    expect(hostEnv({ SWITCHBOARD_HOST_STACK: "s", SWITCHBOARD_AWS_REGION: "us-east-1", SWITCHBOARD_HOST_PARAMS: "A=1" })).toEqual({ stack: "s", region: "us-east-1", params: "A=1", personStack: "s-person-deploy", driftTimeoutSeconds: 300, driftPollSeconds: 5 });
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

describe("host-ops person-deploy", () => {
  const p = { ...e, params: undefined };
  const ADMIN = "arn:aws:iam::aws:policy/AdministratorAccess";
  const attach = (c: string) => c.startsWith("aws iam attach-role-policy --role-name switchboard-host-person-deploy --policy-arn " + ADMIN);
  const detach = (c: string) => c.startsWith("aws iam detach-role-policy --role-name switchboard-host-person-deploy --policy-arn " + ADMIN);

  test("runs the change set as the person's deploy role, never DeployRole, keeps the previous parameters, and detaches AdministratorAccess last", async () => {
    const f = fake();
    expect(await runHostOperation("person-deploy", p, f.d)).toBe(`executed ${changeSet.split(" ").at(-1)}`);
    const deploy = f.calls.find((c) => c.startsWith("aws cloudformation deploy"))!;
    expect(deploy).toContain("--role-arn arn:person-role");
    expect(f.calls.some((c) => c.includes("OutputKey=='DeployRoleArn'"))).toBe(false);
    expect(deploy).not.toContain("--parameter-overrides");
    expect(f.calls.some((c) => c.includes("edge-header"))).toBe(false);
    const a = f.calls.findIndex(attach);
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(f.calls.indexOf(deploy));
    expect(detach(f.calls.at(-1)!)).toBe(true);
    expect(f.calls.filter(detach)).toHaveLength(1);
  });

  test("SWITCHBOARD_HOST_PARAMS changes only the parameters it names", async () => {
    const f = fake();
    await runHostOperation("person-deploy", { ...e, params: "InstanceType=t4g.large" }, f.d);
    expect(f.calls.find((c) => c.startsWith("aws cloudformation deploy"))).toContain("--parameter-overrides InstanceType=t4g.large");
  });

  test("detaches AdministratorAccess whatever happens after it was attached: a refused, a failed or an empty change set", async () => {
    const instance = { Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "Instance", ResourceType: "AWS::EC2::Instance", Replacement: "True" } }] };
    const cases: Array<[string, Array<[string, { ok?: boolean; out?: string; err?: string }]>, RegExp | string]> = [
      ["refused", [["aws cloudformation describe-change-set", { out: JSON.stringify(instance) }]], /replaces the instance/],
      ["deploy failed", [["aws cloudformation deploy", { ok: false, err: "AccessDenied" }]], "failed: aws cloudformation deploy"],
      ["execute failed", [["aws cloudformation execute-change-set", { ok: false, err: "boom" }]], /execute-change-set/],
      ["wait failed", [["aws cloudformation wait", { ok: false, err: "UPDATE_ROLLBACK_COMPLETE" }]], /wait/],
    ];
    for (const [, answers, error] of cases) {
      const f = fake(answers);
      await expect(runHostOperation("person-deploy", p, f.d)).rejects.toThrow(error);
      expect(detach(f.calls.at(-1)!)).toBe(true);
    }
    const empty = fake([["aws cloudformation deploy", { out: "No changes to deploy. Stack switchboard-host is up to date\n" }]]);
    expect(await runHostOperation("person-deploy", p, empty.d)).toBe("no changes");
    expect(detach(empty.calls.at(-1)!)).toBe(true);
  });

  test("a replacing change set passes only with --allow-replace", async () => {
    const instance = { Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "Instance", ResourceType: "AWS::EC2::Instance", Replacement: "True" } }] };
    const f = fake([["aws cloudformation describe-change-set", { out: JSON.stringify(instance) }]]);
    expect(await runHostOperation("person-deploy", { ...p, allowReplace: true }, f.d)).toStartWith("executed ");
    expect(detach(f.calls.at(-1)!)).toBe(true);
  });

  test("a policy left by a run that died is detached before anything else, then attached again for this run", async () => {
    const f = fake([["aws iam list-attached-role-policies", { out: `${ADMIN}\n` }]]);
    await runHostOperation("person-deploy", p, f.d);
    const first = f.calls.findIndex(detach);
    expect(first).toBeLessThan(f.calls.findIndex(attach));
    expect(f.calls.filter(detach)).toHaveLength(2);
    expect(f.logs.join("\n")).toContain("前の回の AdministratorAccess が残っていた");
  });

  test("a policy left by a run that died is detached before install, build or any other read, so a failed start does not keep it", async () => {
    const f = fake([["aws iam list-attached-role-policies", { out: `${ADMIN}\n` }], ["bun install", { ok: false }]]);
    await expect(runHostOperation("person-deploy", p, f.d)).rejects.toThrow("failed: bun install");
    expect(f.calls.findIndex(detach)).toBeLessThan(f.calls.findIndex((c) => c.startsWith("bun install")));
    expect(f.calls.some(attach)).toBe(false);
  });

  test("an attach the CLI reports as failed is still detached; one that never happened leaves the attach's error", async () => {
    const applied = fake([["aws iam attach-role-policy", { ok: false, err: "Read timeout" }]]);
    await expect(runHostOperation("person-deploy", p, applied.d)).rejects.toThrow(/attach-role-policy/);
    expect(detach(applied.calls.at(-1)!)).toBe(true);
    const never = fake([["aws iam attach-role-policy", { ok: false, err: "AccessDenied" }], ["aws iam detach-role-policy", { ok: false, err: "NoSuchEntity" }]]);
    await expect(runHostOperation("person-deploy", p, never.d)).rejects.toThrow(/attach-role-policy: AccessDenied/);
  });

  test("a detach that fails for any reason but NoSuchEntity is a failure that says how to detach by hand", async () => {
    // whatever a listing says afterwards (it can lag the change): only NoSuchEntity is taken as "not attached"
    const f = fake([["aws iam detach-role-policy", { ok: false, err: "Throttling" }]]);
    await expect(runHostOperation("person-deploy", p, f.d)).rejects.toThrow(/AdministratorAccess を外せなかった.*aws iam detach-role-policy --role-name switchboard-host-person-deploy/);
  });

  test("nothing is attached when the person's deploy role cannot be read", async () => {
    const f = fake([["aws cloudformation describe-stacks --stack-name switchboard-host-person-deploy", { ok: false, err: "Stack does not exist" }]]);
    await expect(runHostOperation("person-deploy", p, f.d)).rejects.toThrow(/describe-stacks/);
    expect(f.calls.some(attach)).toBe(false);
  });

  test("--allow-replace is person-deploy's only; person-deploy needs --yes; the workflow cannot pick person-deploy", async () => {
    expect(parseArgs(["person-deploy", "--yes", "--allow-replace"])).toEqual({ action: "person-deploy", dryRun: false, allowReplace: true });
    expect(parseArgs(["person-deploy"])).toBeNull();
    expect(parseArgs(["deploy", "--yes", "--allow-replace"])).toBeNull();
    const wf = await Bun.file(new URL("../.github/workflows/host.yml", import.meta.url)).text();
    expect(wf).toContain("options: [status, start, rebuild, deploy]");
  });
});

describe("host-ops person-drift", () => {
  const p = { ...e, params: undefined };
  const ADMIN = "arn:aws:iam::aws:policy/AdministratorAccess";
  const attach = (c: string) => c.startsWith("aws iam attach-role-policy --role-name switchboard-host-person-deploy --policy-arn " + ADMIN);
  const detach = (c: string) => c.startsWith("aws iam detach-role-policy --role-name switchboard-host-person-deploy --policy-arn " + ADMIN);
  const status = (o: object) => ["aws cloudformation describe-stack-drift-detection-status", { out: JSON.stringify(o) }] as [string, { out: string }];
  const detect: [string, { out: string }] = ["aws cloudformation detect-stack-drift", { out: "drift-id\n" }];

  test("in sync: detects drift while the role holds AdministratorAccess, installs and builds nothing, detaches last", async () => {
    const f = fake([detect, status({ DetectionStatus: "DETECTION_COMPLETE", StackDriftStatus: "IN_SYNC" })]);
    expect(await runHostOperation("person-drift", p, f.d)).toBe("drift: IN_SYNC");
    expect(f.calls.findIndex(attach)).toBeLessThan(f.calls.findIndex((c) => c.startsWith("aws cloudformation detect-stack-drift --stack-name switchboard-host")));
    expect(f.calls.some((c) => c.startsWith("bun "))).toBe(false);
    expect(detach(f.calls.at(-1)!)).toBe(true);
  });

  test("drifted: names each modified or deleted resource", async () => {
    const drifts = { StackResourceDrifts: [{ LogicalResourceId: "DeployRole", StackResourceDriftStatus: "MODIFIED", PropertyDifferences: [{}, {}] }] };
    const f = fake([detect, status({ DetectionStatus: "DETECTION_COMPLETE", StackDriftStatus: "DRIFTED" }), ["aws cloudformation describe-stack-resource-drifts", { out: JSON.stringify(drifts) }]]);
    const out = await runHostOperation("person-drift", p, f.d);
    expect(out).toContain("drift: DRIFTED");
    expect(out).toContain("- DeployRole: MODIFIED（プロパティの差 2）");
    expect(f.calls.find((c) => c.startsWith("aws cloudformation describe-stack-resource-drifts"))).toContain("--stack-resource-drift-status-filters MODIFIED DELETED");
    expect(detach(f.calls.at(-1)!)).toBe(true);
  });

  test("waits while the detection is in progress, up to SWITCHBOARD_DRIFT_TIMEOUT_SECONDS", async () => {
    const f = fake([detect]);
    let n = 0;
    const run = f.d.run;
    f.d.run = (cmd) => {
      if (!cmd.join(" ").startsWith("aws cloudformation describe-stack-drift-detection-status")) return run(cmd);
      f.calls.push(cmd.join(" "));
      n++;
      return { ok: true, out: JSON.stringify(n < 3 ? { DetectionStatus: "DETECTION_IN_PROGRESS" } : { DetectionStatus: "DETECTION_COMPLETE", StackDriftStatus: "IN_SYNC" }), err: "" };
    };
    expect(await runHostOperation("person-drift", p, f.d)).toBe("drift: IN_SYNC");
    expect(f.calls.filter((c) => c === "sleep 5")).toHaveLength(2);
    const slow = fake([detect, status({ DetectionStatus: "DETECTION_IN_PROGRESS" })]);
    await expect(runHostOperation("person-drift", { ...p, driftTimeoutSeconds: 10 }, slow.d)).rejects.toThrow(/10 秒で終わらなかった（SWITCHBOARD_DRIFT_TIMEOUT_SECONDS/);
    expect(slow.calls.filter((c) => c === "sleep 5")).toHaveLength(2);
    expect(hostEnv({ SWITCHBOARD_DRIFT_TIMEOUT_SECONDS: "900" }).driftTimeoutSeconds).toBe(900);
    expect(hostEnv({ SWITCHBOARD_DRIFT_TIMEOUT_SECONDS: "x" }).driftTimeoutSeconds).toBe(300);
    // never unbounded: the wait holds AdministratorAccess
    for (const v of ["Infinity", "1e309", "-5", "0"]) expect(hostEnv({ SWITCHBOARD_DRIFT_TIMEOUT_SECONDS: v }).driftTimeoutSeconds).toBe(300);
    expect(hostEnv({ SWITCHBOARD_DRIFT_TIMEOUT_SECONDS: "99999" }).driftTimeoutSeconds).toBe(3600);
    const every = fake([detect, status({ DetectionStatus: "DETECTION_IN_PROGRESS" })]);
    await expect(runHostOperation("person-drift", { ...p, driftTimeoutSeconds: 60, driftPollSeconds: 30 }, every.d)).rejects.toThrow(/60 秒/);
    expect(every.calls.filter((c) => c === "sleep 30")).toHaveLength(2);
    expect(hostEnv({ SWITCHBOARD_DRIFT_POLL_SECONDS: "30" }).driftPollSeconds).toBe(30);
    // an interval longer than the timeout does not stretch the wait
    const long = fake([detect, status({ DetectionStatus: "DETECTION_IN_PROGRESS" })]);
    await expect(runHostOperation("person-drift", { ...p, driftTimeoutSeconds: 60, driftPollSeconds: 3600 }, long.d)).rejects.toThrow(/60 秒/);
    expect(long.calls.filter((c) => c.startsWith("sleep ") && c !== "sleep 15")).toEqual(["sleep 60"]);
  });

  test("a failed or unfinished detection is a failure, and the policy is still detached", async () => {
    for (const st of [{ DetectionStatus: "DETECTION_FAILED", DetectionStatusReason: "AccessDenied" }, { DetectionStatus: "DETECTION_IN_PROGRESS" }]) {
      const f = fake([detect, status(st)]);
      await expect(runHostOperation("person-drift", p, f.d)).rejects.toThrow(/drift の検査が終わらなかった/);
      expect(detach(f.calls.at(-1)!)).toBe(true);
    }
  });

  test("a policy left by a run that died is detached first; person-drift needs --yes and takes no --allow-replace", async () => {
    const f = fake([["aws iam list-attached-role-policies", { out: `${ADMIN}\n` }], detect, status({ DetectionStatus: "DETECTION_COMPLETE", StackDriftStatus: "IN_SYNC" })]);
    await runHostOperation("person-drift", p, f.d);
    expect(f.calls.findIndex(detach)).toBeLessThan(f.calls.findIndex(attach));
    expect(parseArgs(["person-drift"])).toBeNull();
    expect(parseArgs(["person-drift", "--yes", "--allow-replace"])).toBeNull();
    expect(parseArgs(["person-drift", "--yes"])).toEqual({ action: "person-drift", dryRun: false, allowReplace: false });
  });
});

test("the host workflow runs this entry after OIDC, with --yes, and nothing of its own", async () => {
  const wf = await Bun.file(new URL("../.github/workflows/host.yml", import.meta.url)).text();
  expect(wf).toContain('bun scripts/host-ops.ts "$ACTION" --yes');
  expect(wf.indexOf("configure-aws-credentials")).toBeLessThan(wf.indexOf("run: bun scripts/host-ops.ts"));
  for (const gone of ["sam deploy", "ssm get-parameter", "curl"]) expect(wf).not.toContain(gone);
});
