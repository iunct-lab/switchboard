/**
 * The Starter (#181, #231): a Lambda behind a Function URL that the start page and sb-rescue call.
 *   GET  /status  → { state: "stopped" | "stopping" | "pending" | "running" | … }
 *   POST /start   → StartInstances on the one host instance (409 while it is still stopping, and with reason "capacity"
 *                   when AWS has no Spot capacity for it)
 *   POST /rebuild → replace the instance's root volume with one in its launch state (CreateReplaceRootVolumeTask). The
 *                   instance, its id, its VPC origins and its Spot request stay; EC2 reboots it, UserData runs again on
 *                   the fresh disk and sqlite comes back from Litestream. EC2 does this only for a running instance:
 *                   409 otherwise, and 409 while a replacement is still going on
 *   (passkey path only) POST /_auth/stop { force? } → StopInstances on the one host instance (#1394): running only;
 *                   stopping only with force (Force: true), and force only for a stopping one; 409 otherwise
 * Every path needs `x-switchboard-edge` (the value CloudFront adds; 403 for a direct call to the Function URL, /status
 * included). These POSTs also need `x-switchboard-start-token` equal to the SecureString in Parameter Store: they are for machines
 * (the GitHub workflow, sb-rescue). A person uses `/_auth/*` (auth.ts, #211): a passkey and a cookie, no token.
 * A scheduled event (EventBridge, every 5 minutes; no `requestContext.http`) runs countries.reconcile (#1639): the
 * temporary extra countries of the geo restriction end, or come back after a redeploy.
 * It starts, and replaces the root volume of, only this instance (aws/template.yaml gives it nothing else).
 */
import { CreateReplaceRootVolumeTaskCommand, DescribeInstancesCommand, DescribeReplaceRootVolumeTasksCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { S3Client } from "@aws-sdk/client-s3";
import { timingSafeEqual } from "node:crypto";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { makeAuth, makeParams } from "./auth.ts";
import { makeCountries } from "./countries.ts";

/** The part of an AWS SDK v3 client used here; tests pass fakes. */
export interface Sender {
  send(command: object): Promise<unknown>;
}
export interface StarterDeps {
  ec2: Sender;
  ssm: Sender;
  instanceId: string;
  tokenParam: string;
  now?: () => number;
  /** Passkey login (#211): absent = no `/_auth/*` (a test of the machine paths only). */
  auth?: { s3: Sender; bucket: string; publicOrigin: string };
  /** Temporary extra countries (#1639): CloudFront and the stack's always-allowed countries. Uses auth's s3 and bucket. */
  countries?: { cloudfront: Sender; base: string[] };
}
/** The Function URL event and response, only the fields used. */
export interface UrlEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string } };
}
/** A scheduled EventBridge event: no Function URL fields. */
export interface TickEvent {
  source?: string;
}
export interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}

const reply = (statusCode: number, body: unknown): UrlResult => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

const EDGE_PARAM = "/switchboard/edge-header";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function makeHandler(d: StarterDeps) {
  const now = d.now ?? Date.now;
  const param = makeParams(d.ssm, now);
  const describe = async () => {
    const r = (await d.ec2.send(new DescribeInstancesCommand({ InstanceIds: [d.instanceId] }))) as { Reservations?: Array<{ Instances?: Array<{ State?: { Name?: string } }> }> };
    return r.Reservations?.[0]?.Instances?.[0];
  };
  // "stopping" stays itself: a start is refused until the stop has finished, and the page says so
  const state = async () => (await describe())?.State?.Name ?? "unknown";
  /** An AWS error the page can act on (wait, then try again) → 409 with a message instead of a bare 502. */
  const conflict = (e: unknown): { error: string; reason?: "capacity" } | null => {
    const err = e as { name?: string; message?: string };
    if (err.name === "IncorrectInstanceState") return { error: "機械はまだ停止の途中です（または状態が変わったところです）。少し待ってからもう一度押してください" };
    // Right after a stop, the persistent Spot request takes about a minute to become "disabled" (startable) again;
    // StartInstances is refused until then. The page retries a 409 by itself (#211, seen on the first deploy).
    if (err.name === "IncorrectSpotRequestState") return { error: "止まった直後で、まだ起動できる状態になっていません（1 分ほどかかります）" };
    // AWS has no Spot capacity of this type in this zone right now (#443, 2026-09-28): it may come back in minutes
    if (err.name === "InsufficientInstanceCapacity") return { error: "AWS に今この型の Spot の空きがありません。しばらく待つと空くことがあります", reason: "capacity" };
    return null;
  };

  /** start / stop / 作り直す, shared by the machine paths and the passkey ones; AWS conflicts become 409 with a message. */
  const act = async (what: "start" | "stop" | "rebuild", o: { force?: boolean } = {}): Promise<UrlResult> => {
    try {
      if (what === "stop") return await stop(o.force === true);
      if (what === "start") {
        await d.ec2.send(new StartInstancesCommand({ InstanceIds: [d.instanceId] }));
        return reply(202, { started: true });
      }
      return await rebuild();
    } catch (e) {
      const why = conflict(e);
      if (why) return reply(409, why);
      throw e;
    }
  };
  const countries = d.auth && d.countries && makeCountries({ cloudfront: d.countries.cloudfront, s3: d.auth.s3, ssm: d.ssm, bucket: d.auth.bucket, base: d.countries.base, now });
  const auth = d.auth && makeAuth({ countries, ssm: d.ssm, param, s3: d.auth.s3, bucket: d.auth.bucket, publicOrigin: d.auth.publicOrigin, now, state, start: () => act("start"), stop: (force) => act("stop", { force }), rebuild: () => act("rebuild") });

  return async (event: UrlEvent | TickEvent): Promise<UrlResult | { ok: true }> => {
    if (!("requestContext" in event && event.requestContext?.http)) {
      if ((event as TickEvent).source === "aws.events") {
        await countries?.reconcile();
        return { ok: true };
      }
      return reply(404, { error: "not found" });
    }
    return url(event);
  };
  async function url(event: UrlEvent): Promise<UrlResult> {
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/\/+$/, "") || "/";
    // Only CloudFront reaches any path: it adds the shared header, as it does for the host (#228). Calling the Function URL
    // directly gets nothing, /status included. A mismatch reads the header again once (it may have just been rotated).
    const given = event.headers?.["x-switchboard-edge"] ?? "";
    let edge = await param(EDGE_PARAM);
    if (!edge || !same(given, edge)) edge = await param(EDGE_PARAM, true);
    if (!edge || !same(given, edge)) return reply(403, { error: "配信元を経由してください" });
    if (auth && (path === "/_auth" || path.startsWith("/_auth/"))) {
      const headers = event.headers ?? {};
      // the viewer: CloudFront-Viewer-Address ("<ip>:<port>", set by CloudFront, not spoofable; forwarded by the /_auth*
      // origin request policy), else whoever called the Function URL — never X-Forwarded-For, whose first entry the viewer
      // writes (if the header ever goes missing, every failure counts against one CloudFront bucket: safe, not bypassable)
      const viewer = headers["cloudfront-viewer-address"]?.replace(/^\[?([^\]]*?)\]?:\d+$/, "$1");
      return auth({
        method,
        path: event.rawPath,
        headers,
        cookies: event.cookies ?? (headers.cookie ? headers.cookie.split(";") : []),
        body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : "",
        sourceIp: viewer || event.requestContext.http.sourceIp || "",
      });
    }
    if (method === "GET" && path === "/status") return reply(200, { state: await state() });
    if (method !== "POST" || (path !== "/start" && path !== "/rebuild")) return reply(404, { error: "not found" });
    const token = event.headers?.["x-switchboard-start-token"] ?? "";
    let want = await param(d.tokenParam);
    if (!want || !same(token, want)) want = await param(d.tokenParam, true); // at most once per FORCED_REREAD_MS
    if (!want || !same(token, want)) return reply(403, { error: "start token does not match" });
    return act(path === "/start" ? "start" : "rebuild");
  }

  async function stop(force: boolean): Promise<UrlResult> {
    const st = await state();
    if (st === "stopping" && !force) return reply(409, { error: "止めている途中です。進まないときは強制停止を選んでください", reason: "stopping" });
    // Force skips the OS shutdown: only for a machine that is already stopping and does not get there
    if (force && st !== "stopping") return reply(409, { error: `強制停止は、停止の途中で進まないときだけ使えます（今は ${st}）` });
    if (st !== "running" && st !== "stopping") return reply(409, { error: st === "pending" ? "機械は起動の途中です。起動し終わってから止めてください" : `機械は止まっています（今は ${st}）` });
    try {
      await d.ec2.send(new StopInstancesCommand({ InstanceIds: [d.instanceId], Force: force }));
    } catch (e) {
      // the boundary / role change is not deployed yet: say so instead of a bare 502
      if ((e as { name?: string }).name === "UnauthorizedOperation") return reply(403, { error: "この機械を止める権限がまだありません（テンプレートの deploy が要ります）" });
      throw e;
    }
    return reply(202, { stopping: true, force });
  }

  async function rebuild(): Promise<UrlResult> {
    const st = await state();
    if (st !== "running") return reply(409, { error: `作り直しは動いている機械でだけできます（今は ${st}）。先に起動してから、もう一度押してください` });
    const tasks = (await d.ec2.send(new DescribeReplaceRootVolumeTasksCommand({ Filters: [{ Name: "instance-id", Values: [d.instanceId] }] }))) as { ReplaceRootVolumeTasks?: Array<{ TaskState?: string }> };
    if (tasks.ReplaceRootVolumeTasks?.some((t) => ["pending", "in-progress", "failing", "failing-detached"].includes(t.TaskState ?? ""))) return reply(409, { error: "作り直しの途中です。終わるまで待ってください" });
    // the old root volume is deleted once the new one is attached (if the task fails, EC2 keeps the old one attached)
    const r = (await d.ec2.send(new CreateReplaceRootVolumeTaskCommand({ InstanceId: d.instanceId, DeleteReplacedRootVolume: true }))) as { ReplaceRootVolumeTask?: { ReplaceRootVolumeTaskId?: string } };
    return reply(202, { rebuilding: true, task: r.ReplaceRootVolumeTask?.ReplaceRootVolumeTaskId ?? null });
  }
}

let real: ((e: UrlEvent | TickEvent) => Promise<UrlResult | { ok: true }>) | undefined;
/** The Lambda entry: real clients, settings from the environment aws/template.yaml gives the function. */
export const handler = (event: UrlEvent | TickEvent) => {
  real ??= makeHandler({
    ec2: new EC2Client({}),
    ssm: new SSMClient({}),
    instanceId: process.env.SB_INSTANCE_ID ?? "",
    tokenParam: process.env.SB_START_TOKEN_PARAM ?? "/switchboard/start-token",
    auth: process.env.SB_PUBLIC_ORIGIN && process.env.SB_DATA_BUCKET ? { s3: new S3Client({}), bucket: process.env.SB_DATA_BUCKET, publicOrigin: process.env.SB_PUBLIC_ORIGIN } : undefined,
    // CloudFront's API lives in us-east-1
    countries: { cloudfront: new CloudFrontClient({ region: "us-east-1" }), base: (process.env.SB_ALLOWED_COUNTRIES ?? "").split(",").filter(Boolean) },
  });
  return real(event);
};
