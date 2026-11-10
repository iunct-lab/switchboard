/**
 * The cloud host's status / start / rebuild / deploy (#917), the same from a terminal and from `.github/workflows/host.yml`:
 * the workflow reaches AWS through OIDC and then runs this; a person runs it with their own AWS CLI login (`aws sso login`,
 * a profile in AWS_PROFILE). Nothing here stores or asks for AWS credentials, and nothing goes to Switchboard.
 * start / rebuild ask the stack's Starter with the start token and the edge header (read from SSM, never printed);
 * deploy builds a change set run by the stack's DeployRole and executes it only when aws/change-set-check.ts lets it:
 * not when it touches the launch template or the instance (a replaced Instance is a person's deploy, aws/README.md).
 * deploy is the workflow's. A person deploys with person-deploy and their own administrator login: the change set runs as
 * the role of aws/person-deploy.yaml, which holds no permission except while person-deploy runs (it attaches
 * AdministratorAccess first and detaches it at the end, whatever happened, and detaches one left by a run that died).
 * A role passed to a stack stays attached and anyone who may operate on the stack can use it, so no role here keeps a
 * standing permission beyond DeployRole's. person-deploy keeps every parameter's previous value unless
 * SWITCHBOARD_HOST_PARAMS names it, and refuses to replace the instance unless `--allow-replace`.
 * `--dry-run` prints the plan and calls nothing (no AWS, no secret); start / rebuild / deploy / person-deploy need `--yes`.
 * Stack and region: SWITCHBOARD_HOST_STACK (switchboard-host), SWITCHBOARD_AWS_REGION (ap-northeast-1); deploy's
 * `--parameter-overrides` from SWITCHBOARD_HOST_PARAMS (the repository variable of the same name); the person's deploy
 * role's stack from SWITCHBOARD_PERSON_DEPLOY_STACK (`<stack>-person-deploy`).
 */
import { checkChangeSet, type ChangeSet } from "../aws/change-set-check";

export const ACTIONS = ["status", "start", "rebuild", "deploy", "person-deploy", "person-drift"] as const;
export type HostAction = (typeof ACTIONS)[number];

export interface HostEnv {
  stack: string;
  region: string;
  params?: string;
  personStack: string;
  /** person-drift: how long to wait for a drift detection (SWITCHBOARD_DRIFT_TIMEOUT_SECONDS, 300; at most 3600) */
  driftTimeoutSeconds: number;
  /** person-drift: how often to ask whether it has finished (SWITCHBOARD_DRIFT_POLL_SECONDS, 5) */
  driftPollSeconds: number;
  /** person-deploy only: let a change set that replaces the instance through (a person's choice, aws/README.md) */
  allowReplace?: boolean;
  /** person-deploy only: the change set a person looked at, to execute (`--execute=<arn>`) */
  execute?: string;
}

/** A command's result: both streams are kept, so they can be printed with the secrets taken out. */
export type Run = (cmd: string[]) => { ok: boolean; out: string; err: string };
export type Post = (url: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>;
export interface Deps {
  run: Run;
  post: Post;
  log: (s: string) => void;
}

export function hostEnv(env: Record<string, string | undefined> = process.env): HostEnv {
  const stack = env.SWITCHBOARD_HOST_STACK || "switchboard-host";
  return { stack, region: env.SWITCHBOARD_AWS_REGION || "ap-northeast-1", params: env.SWITCHBOARD_HOST_PARAMS || undefined, personStack: env.SWITCHBOARD_PERSON_DEPLOY_STACK || `${stack}-person-deploy`, driftTimeoutSeconds: seconds(env.SWITCHBOARD_DRIFT_TIMEOUT_SECONDS, 300), driftPollSeconds: seconds(env.SWITCHBOARD_DRIFT_POLL_SECONDS, 5) };
}

/**
 * A positive, finite number of seconds, at most an hour: the wait runs while the person's deploy role holds
 * AdministratorAccess, so no value may make it unbounded. Anything else is the default.
 */
function seconds(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : fallback;
}

export const ADMIN_POLICY = "arn:aws:iam::aws:policy/AdministratorAccess";

const NO_AUTH = "AWS に認証できない: 自分のログイン（aws sso login、AWS_PROFILE）を確かめてからやり直す。キーをこのスクリプトや Switchboard に保存しない";

/** What `action` would do, one line a step. Reads nothing. */
export function planHostOperation(action: HostAction, e: HostEnv): string[] {
  const at = `stack ${e.stack}（${e.region}）`;
  if (action === "status") return [`${at} の出力 InstanceId を読む`, "その instance の状態を出す"];
  if (action === "start" || action === "rebuild") {
    return [`${at} の出力 StarterUrl を読む`, "SSM の /switchboard/start-token と /switchboard/edge-header を読む（値は出さない）", `Starter に POST /${action}`];
  }
  if (action === "person-drift") {
    return [
      `stack ${e.personStack} の出力 PersonDeployRoleArn / PersonDeployRoleName を読む`,
      "人の配備用ロールに前の回の AdministratorAccess が残っていれば外す",
      "人の配備用ロールに AdministratorAccess を付ける（自分のログインで。drift の検査はスタックに付いたロールで動く）",
      `${at} の detect-stack-drift を終わるまで待ち、ずれたリソースを出す`,
      "成功しても失敗しても、人の配備用ロールから AdministratorAccess を外す",
    ];
  }
  if (action === "person-deploy" && e.execute) {
    return [
      `stack ${e.personStack} の出力 PersonDeployRoleArn / PersonDeployRoleName を読む`,
      "人の配備用ロールに前の回の AdministratorAccess が残っていれば外す",
      "人の配備用ロールに AdministratorAccess を付ける（自分のログインで）",
      `change set ${e.execute} が ${e.stack} のもので実行できる状態かを確かめ、リソースを 1 行ずつ出し、検査する`,
      "execute-change-set、stack-update-complete を待つ",
      "成功しても失敗しても、人の配備用ロールから AdministratorAccess を外す",
    ];
  }
  if (action === "person-deploy") {
    return [
      "bun install --frozen-lockfile、bun run --cwd aws build",
      `stack ${e.personStack} の出力 PersonDeployRoleArn / PersonDeployRoleName、${at} の出力 DataBucket を読む`,
      "人の配備用ロールに前の回の AdministratorAccess が残っていれば外す",
      "人の配備用ロールに AdministratorAccess を付ける（自分のログインで）",
      "aws cloudformation package（Starter の build を DataBucket に上げる）",
      `aws cloudformation deploy --no-execute-changeset（人の配備用ロールで。パラメータは前の値のまま${e.params ? "、SWITCHBOARD_HOST_PARAMS の分だけ変える" : ""}）`,
      `change set のリソースを 1 行ずつ出して検査し${e.allowReplace ? "（--allow-replace: インスタンスの置き換えも通す）" : "、LaunchTemplate か Instance に触れるなら止める"}`,
      "実行はしない: 中身を見てから person-deploy --execute=<change set> --yes で実行する",
      "成功しても失敗しても、人の配備用ロールから AdministratorAccess を外す",
    ];
  }
  return [
    "bun install --frozen-lockfile、bun run --cwd aws build",
    `${at} の出力 DeployRoleArn と DataBucket、SSM の /switchboard/edge-header を読む（値は出さない）`,
    "aws cloudformation package（Starter の build を DataBucket に上げる）",
    `aws cloudformation deploy --no-execute-changeset（DeployRole で。parameter-overrides は SWITCHBOARD_HOST_PARAMS${e.params ? "" : "。今は未設定なので止まる"}）`,
    "change set が LaunchTemplate か Instance に触れるなら実行せずに理由を出して止める（人の deploy。aws/change-set-check.ts）",
    "触れなければ execute-change-set、stack-update-complete を待つ",
  ];
}

function hide(s: string, secrets: string[]): string {
  return secrets.reduce((acc, v) => (v ? acc.split(v).join("***") : acc), s);
}

export async function runHostOperation(action: HostAction, e: HostEnv, d: Deps): Promise<string> {
  const secrets: string[] = [];
  const aws = (args: string[]) => {
    const r = d.run(["aws", ...args, "--region", e.region]);
    if (!r.ok) throw new Error(`failed: aws ${args.slice(0, 2).join(" ")}${r.err.trim() ? `: ${hide(r.err.trim(), secrets).split("\n").at(-1)}` : ""}`);
    return r.out.trim();
  };
  const output = (key: string) => aws(["cloudformation", "describe-stacks", "--stack-name", e.stack, "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`, "--output", "text"]);
  const secret = (name: string) => {
    const v = aws(["ssm", "get-parameter", "--name", name, "--with-decryption", "--query", "Parameter.Value", "--output", "text"]);
    secrets.push(v);
    return v;
  };
  if (action === "deploy" && !e.params) throw new Error("SWITCHBOARD_HOST_PARAMS が無い（リポジトリ変数の値: gh variable get SWITCHBOARD_HOST_PARAMS）");
  // auth first: a missing login is said as such, before any step; the identity itself is not printed
  if (!d.run(["aws", "sts", "get-caller-identity", "--query", "Arn", "--output", "text", "--region", e.region]).ok) throw new Error(NO_AUTH);

  if (action === "status") return aws(["ec2", "describe-instances", "--instance-ids", output("InstanceId"), "--query", "Reservations[0].Instances[0].State.Name", "--output", "text"]);
  if (action === "start" || action === "rebuild") {
    const url = output("StarterUrl");
    const r = await d.post(`${url.replace(/\/+$/, "")}/${action}`, { "x-switchboard-start-token": secret("/switchboard/start-token"), "x-switchboard-edge": secret("/switchboard/edge-header") });
    const text = hide(r.text.trim(), secrets);
    if (r.status < 200 || r.status >= 300) throw new Error(`Starter が ${r.status} を返した: ${text}`);
    return text;
  }

  // person-deploy / person-drift: the person's own login lends the role AdministratorAccess for this one run (the stack
  // runs both a deploy and a drift detection as the role attached to it). A policy left by a run that died goes first,
  // before anything that can fail (install, build, reads), so it never outlives a failed start
  let person: { roleArn: string; roleName: string; detach: () => string } | undefined;
  if (action === "person-deploy" || action === "person-drift") {
    const personOutput = (key: string) => aws(["cloudformation", "describe-stacks", "--stack-name", e.personStack, "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`, "--output", "text"]);
    const roleArn = personOutput("PersonDeployRoleArn");
    const roleName = personOutput("PersonDeployRoleName");
    const detach = () => aws(["iam", "detach-role-policy", "--role-name", roleName, "--policy-arn", ADMIN_POLICY]);
    const attached = aws(["iam", "list-attached-role-policies", "--role-name", roleName, "--query", "AttachedPolicies[].PolicyArn", "--output", "text"]);
    if (attached.split(/\s+/).includes(ADMIN_POLICY)) {
      d.log(`${action}: 前の回の AdministratorAccess が残っていたので外す`);
      detach();
    }
    person = { roleArn, roleName, detach };
  }

  /** Run `fn` while the person's deploy role holds AdministratorAccess; detached at the end, whatever happened. */
  const withPersonRole = (fn: (roleArn: string) => string): string => {
    const { roleArn, roleName, detach } = person!;
    try {
      // inside the try: an attach that IAM applied but the CLI reported as failed is detached too
      aws(["iam", "attach-role-policy", "--role-name", roleName, "--policy-arn", ADMIN_POLICY]);
      // IAM takes a few seconds to let CloudFormation use a policy just attached
      d.run(["sleep", "15"]);
      return fn(roleArn);
    } finally {
      // never left behind: a role attached to the stack with AdministratorAccess is anyone's who may operate on the stack
      try {
        detach();
      } catch (err) {
        // only IAM's own "not attached" (an attach that never happened) is not a failure; a listing could lag the change,
        // so it is not asked: anything else keeps the error and the command to run by hand
        if (!/NoSuchEntity/.test((err as Error).message)) {
          throw new Error(`AdministratorAccess を外せなかった（${(err as Error).message}）: すぐ手で外す: aws iam detach-role-policy --role-name ${roleName} --policy-arn ${ADMIN_POLICY}`);
        }
      }
      d.log(`${action}: 人の配備用ロールから AdministratorAccess を外した`);
    }
  };

  if (action === "person-drift") {
    return withPersonRole(() => {
      const id = aws(["cloudformation", "detect-stack-drift", "--stack-name", e.stack, "--query", "StackDriftDetectionId", "--output", "text"]);
      const status = () => JSON.parse(aws(["cloudformation", "describe-stack-drift-detection-status", "--stack-drift-detection-id", id, "--output", "json"])) as { DetectionStatus?: string; StackDriftStatus?: string; DetectionStatusReason?: string };
      let st = status();
      // detection takes a minute or so; bounded so a stuck one ends (and the policy is detached). A bigger stack may need
      // longer: SWITCHBOARD_DRIFT_TIMEOUT_SECONDS (and SWITCHBOARD_DRIFT_POLL_SECONDS for how often to ask)
      // each sleep is cut to what is left, so no interval stretches the wait past the timeout
      for (let waited = 0; st.DetectionStatus === "DETECTION_IN_PROGRESS" && waited < e.driftTimeoutSeconds; ) {
        const step = Math.min(e.driftPollSeconds, e.driftTimeoutSeconds - waited);
        d.run(["sleep", String(step)]);
        waited += step;
        st = status();
      }
      if (st.DetectionStatus !== "DETECTION_COMPLETE") {
        const more = st.DetectionStatus === "DETECTION_IN_PROGRESS" ? `${e.driftTimeoutSeconds} 秒で終わらなかった（SWITCHBOARD_DRIFT_TIMEOUT_SECONDS で延ばせる）` : st.DetectionStatusReason ?? "";
        throw new Error(`drift の検査が終わらなかった（${st.DetectionStatus}）: ${more}`);
      }
      if (st.StackDriftStatus !== "DRIFTED") return `drift: ${st.StackDriftStatus}`;
      const drifts = JSON.parse(aws(["cloudformation", "describe-stack-resource-drifts", "--stack-name", e.stack, "--stack-resource-drift-status-filters", "MODIFIED", "DELETED", "--output", "json"])) as {
        StackResourceDrifts?: { LogicalResourceId?: string; StackResourceDriftStatus?: string; PropertyDifferences?: unknown[] }[];
      };
      const lines = (drifts.StackResourceDrifts ?? []).map((r) => `- ${r.LogicalResourceId}: ${r.StackResourceDriftStatus}（プロパティの差 ${r.PropertyDifferences?.length ?? 0}）`);
      return ["drift: DRIFTED", ...lines, `差分の中身: aws cloudformation describe-stack-resource-drifts --stack-name ${e.stack}（Admin のログインでも読める）`].join("\n");
    });
  }

  /** Print a change set one resource a line and check it; throws when it may not run. */
  const review = (cs: string, allowReplace: boolean): ChangeSet & { StackName?: string; ExecutionStatus?: string } => {
    const described = JSON.parse(aws(["cloudformation", "describe-change-set", "--change-set-name", cs, "--output", "json"]));
    for (const c of (described as ChangeSet).Changes ?? []) d.log(`change: ${c.ResourceChange?.Action} ${c.ResourceChange?.LogicalResourceId} (replacement: ${c.ResourceChange?.Replacement ?? "-"})`);
    const verdict = checkChangeSet(described, { allowReplace });
    if (!verdict.ok) throw new Error(`not executed: ${verdict.reason}`);
    return described;
  };
  const execute = (cs: string): string => {
    aws(["cloudformation", "execute-change-set", "--change-set-name", cs]);
    aws(["cloudformation", "wait", "stack-update-complete", "--stack-name", e.stack]);
    return `executed ${cs}`;
  };

  if (action === "person-deploy" && e.execute) {
    const cs = e.execute;
    return withPersonRole(() => {
      const described = review(cs, e.allowReplace ?? false);
      // only a change set of this stack that can still run: another stack's, or one already run, is refused
      if (described.StackName !== e.stack) throw new Error(`not executed: ${cs} は ${e.stack} の change set ではない（${described.StackName}）`);
      if (described.ExecutionStatus !== "AVAILABLE") throw new Error(`not executed: ${cs} は実行できる状態ではない（${described.ExecutionStatus}）`);
      return execute(cs);
    });
  }

  for (const cmd of [["bun", "install", "--frozen-lockfile"], ["bun", "run", "--cwd", "aws", "build"]]) {
    if (!d.run(cmd).ok) throw new Error(`failed: ${cmd.join(" ")}`);
  }
  const bucket = output("DataBucket");

  /** Package, make the change set as `role`, check it, execute it. "no changes" for an empty one. */
  /**
   * Package and make the change set as `role`, print and check it. The workflow's deploy executes it at once; a person's
   * stops there, so the person reads it first and runs `person-deploy --execute=<arn>` (as with the manual steps before).
   */
  const deploy = (role: string, overrides: string[], allowReplace: boolean, run: boolean): string => {
    // the AWS CLI, not sam: sam deploy / sam package cannot read the template's Fn::ForEach (#465). The SAM transform
    // still runs in CloudFormation; package only uploads the Starter's build and points CodeUri at it
    const packaged = "dist/template.packaged.yaml";
    aws(["cloudformation", "package", "--template-file", "aws/template.yaml", "--s3-bucket", bucket, "--s3-prefix", "releases/sam", "--output-template-file", packaged]);
    const r = d.run([
      "aws", "cloudformation", "deploy", "--template-file", packaged, "--stack-name", e.stack, "--region", e.region, "--role-arn", role, "--s3-bucket", bucket, "--s3-prefix", "releases/sam",
      "--capabilities", "CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND", "--no-execute-changeset", "--no-fail-on-empty-changeset", "--tags", "Project=switchboard",
      ...(overrides.length ? ["--parameter-overrides", ...overrides] : []),
    ]);
    // the edge header must not reach a log, whatever the CLI prints
    d.log(hide(`${r.out}\n${r.err}`.trim(), secrets));
    // a failed deploy is a failure, never "no changes" (#759)
    if (!r.ok) throw new Error("failed: aws cloudformation deploy");
    const cs = [...`${r.out}\n${r.err}`.matchAll(/arn:aws:cloudformation:[^\s]+:changeSet\/[^\s]+/g)].at(-1)?.[0];
    if (!cs) return "no changes";
    review(cs, allowReplace);
    if (run) return execute(cs);
    return `created ${cs}\n上の change の行を見て、よければ実行する: bun scripts/host-ops.ts person-deploy --execute=${cs} --yes${allowReplace ? " --allow-replace" : ""}`;
  };

  if (action === "deploy") {
    // the change set runs as the stack's DeployRole (the boundary keeps it to this stack); the caller only passes it
    const role = output("DeployRoleArn");
    const edge = secret("/switchboard/edge-header");
    return deploy(role, [...e.params!.split(/\s+/).filter(Boolean), `EdgeHeaderValue=${edge}`], false, true);
  }

  return withPersonRole((roleArn) => deploy(roleArn, (e.params ?? "").split(/\s+/).filter(Boolean), e.allowReplace ?? false, false));
}

/**
 * The arguments: one action, `--dry-run`, `--yes`; with person-deploy also `--allow-replace` and `--execute=<change set
 * ARN>`. Anything else, or an action other than status without `--yes` or `--dry-run`, is null.
 */
export function parseArgs(args: string[]): { action: HostAction; dryRun: boolean; allowReplace: boolean; execute?: string } | null {
  const action = args.find((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  const person = action === "person-deploy";
  const known = (f: string) => ["--dry-run", "--yes"].includes(f) || (person && (f === "--allow-replace" || /^--execute=arn:aws:cloudformation:[^\s]+:changeSet\/\S+$/.test(f)));
  if (!ACTIONS.includes(action as HostAction) || args.filter((a) => !a.startsWith("--")).length !== 1 || !flags.every(known)) return null;
  if (flags.filter((f) => f.startsWith("--execute=")).length > 1) return null;
  const dryRun = flags.includes("--dry-run");
  if (action !== "status" && !dryRun && !flags.includes("--yes")) return null;
  const execute = flags.find((f) => f.startsWith("--execute="))?.slice("--execute=".length);
  return { action: action as HostAction, dryRun, allowReplace: flags.includes("--allow-replace"), ...(execute ? { execute } : {}) };
}

export const spawnRun: Run = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdin: "ignore" });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
};

export const fetchPost: Post = async (url, headers) => {
  const r = await fetch(url, { method: "POST", headers });
  return { status: r.status, text: await r.text() };
};

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: bun scripts/host-ops.ts <status|start|rebuild|deploy|person-deploy|person-drift> [--dry-run] [--yes] [--allow-replace] [--execute=<change set>]（status 以外は --yes か --dry-run が要る。--allow-replace と --execute は person-deploy だけ。person-deploy は change set を作って止まり、中身を見てから --execute で実行する。人の配備は person-deploy、deploy は GitHub の workflow 用）");
    process.exit(2);
  }
  const e = { ...hostEnv(), allowReplace: parsed.allowReplace, execute: parsed.execute };
  if (parsed.dryRun) {
    for (const l of planHostOperation(parsed.action, e)) console.log(`- ${l}`);
    process.exit(0);
  }
  try {
    console.log(await runHostOperation(parsed.action, e, { run: spawnRun, post: fetchPost, log: console.log }));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
