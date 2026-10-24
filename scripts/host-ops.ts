/**
 * The cloud host's status / start / rebuild / deploy (#917), the same from a terminal and from `.github/workflows/host.yml`:
 * the workflow reaches AWS through OIDC and then runs this; a person runs it with their own AWS CLI login (`aws sso login`,
 * a profile in AWS_PROFILE). Nothing here stores or asks for AWS credentials, and nothing goes to Switchboard.
 * start / rebuild ask the stack's Starter with the start token and the edge header (read from SSM, never printed);
 * deploy builds a change set run by the stack's DeployRole and executes it only when it touches neither the launch
 * template nor the instance (a replaced Instance orphans its Spot request: that one is a person's, aws/README.md).
 * `--dry-run` prints the plan and calls nothing (no AWS, no secret); start / rebuild / deploy need `--yes`.
 * Stack and region: SWITCHBOARD_HOST_STACK (switchboard-host), SWITCHBOARD_AWS_REGION (ap-northeast-1); deploy's
 * `--parameter-overrides` from SWITCHBOARD_HOST_PARAMS (the repository variable of the same name).
 */
export const ACTIONS = ["status", "start", "rebuild", "deploy"] as const;
export type HostAction = (typeof ACTIONS)[number];

export interface HostEnv {
  stack: string;
  region: string;
  params?: string;
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
  return { stack: env.SWITCHBOARD_HOST_STACK || "switchboard-host", region: env.SWITCHBOARD_AWS_REGION || "ap-northeast-1", params: env.SWITCHBOARD_HOST_PARAMS || undefined };
}

const NO_AUTH = "AWS に認証できない: 自分のログイン（aws sso login、AWS_PROFILE）を確かめてからやり直す。キーをこのスクリプトや Switchboard に保存しない";

/** What `action` would do, one line a step. Reads nothing. */
export function planHostOperation(action: HostAction, e: HostEnv): string[] {
  const at = `stack ${e.stack}（${e.region}）`;
  if (action === "status") return [`${at} の出力 InstanceId を読む`, "その instance の状態を出す"];
  if (action === "start" || action === "rebuild") {
    return [`${at} の出力 StarterUrl を読む`, "SSM の /switchboard/start-token と /switchboard/edge-header を読む（値は出さない）", `Starter に POST /${action}`];
  }
  return [
    "bun install --frozen-lockfile、bun run --cwd aws build",
    `${at} の出力 DeployRoleArn と DataBucket、SSM の /switchboard/edge-header を読む（値は出さない）`,
    `sam deploy --no-execute-changeset（DeployRole で。parameter-overrides は SWITCHBOARD_HOST_PARAMS${e.params ? "" : "。今は未設定なので止まる"}）`,
    "change set が LaunchTemplate か Instance に触れるなら実行せずに止める（人の deploy）",
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

  for (const cmd of [["bun", "install", "--frozen-lockfile"], ["bun", "run", "--cwd", "aws", "build"]]) {
    if (!d.run(cmd).ok) throw new Error(`failed: ${cmd.join(" ")}`);
  }
  const role = output("DeployRoleArn");
  const bucket = output("DataBucket");
  const edge = secret("/switchboard/edge-header");
  // the change set runs as the stack's DeployRole (the boundary keeps it to this stack); the caller only passes it
  const sam = d.run([
    "sam", "deploy", "--template-file", "aws/template.yaml", "--stack-name", e.stack, "--region", e.region, "--role-arn", role, "--s3-bucket", bucket, "--s3-prefix", "releases/sam",
    "--capabilities", "CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "--no-execute-changeset", "--no-fail-on-empty-changeset", "--tags", "Project=switchboard",
    "--parameter-overrides", ...e.params!.split(/\s+/).filter(Boolean), `EdgeHeaderValue=${edge}`,
  ]);
  // sam prints the parameter overrides: the edge header must not reach a log
  d.log(hide(`${sam.out}\n${sam.err}`.trim(), secrets));
  // a failed sam deploy is a failure, never "no changes" (#759)
  if (!sam.ok) throw new Error("failed: sam deploy");
  const cs = [...`${sam.out}\n${sam.err}`.matchAll(/arn:aws:cloudformation:[^\s]+:changeSet\/[^\s]+/g)].at(-1)?.[0];
  if (!cs) return "no changes";
  const touched = aws(["cloudformation", "describe-change-set", "--change-set-name", cs, "--query", "Changes[?ResourceChange.LogicalResourceId=='Instance' || ResourceChange.LogicalResourceId=='LaunchTemplate'].ResourceChange.LogicalResourceId", "--output", "text"]);
  if (touched && touched !== "None") throw new Error(`this change set touches the launch template or the instance (${touched}); run it by hand after cancelling the Spot request (aws/README.md)`);
  aws(["cloudformation", "execute-change-set", "--change-set-name", cs]);
  aws(["cloudformation", "wait", "stack-update-complete", "--stack-name", e.stack]);
  return `executed ${cs}`;
}

/** The arguments: one action, `--dry-run`, `--yes`. Anything else, or start / rebuild / deploy without either flag, is null. */
export function parseArgs(args: string[]): { action: HostAction; dryRun: boolean } | null {
  const action = args.find((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (!ACTIONS.includes(action as HostAction) || args.filter((a) => !a.startsWith("--")).length !== 1 || flags.some((f) => f !== "--dry-run" && f !== "--yes")) return null;
  const dryRun = flags.includes("--dry-run");
  if (action !== "status" && !dryRun && !flags.includes("--yes")) return null;
  return { action: action as HostAction, dryRun };
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
    console.error("usage: bun scripts/host-ops.ts <status|start|rebuild|deploy> [--dry-run] [--yes]（start / rebuild / deploy は --yes か --dry-run が要る）");
    process.exit(2);
  }
  const e = hostEnv();
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
