import { describe, expect, test } from "bun:test";
import { CreateReplaceRootVolumeTaskCommand, DescribeInstancesCommand, DescribeReplaceRootVolumeTasksCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { FORCED_REREAD_MS } from "./auth.ts";
import { makeHandler, type Sender, type UrlEvent } from "./starter.ts";

/** An AWS SDK error as the clients throw it: `name` is the service's error code. */
const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

/** aws/starter.ts (#231) with fake SDK clients: what each route sends, and the start token. */
const EDGE = "edge-secret-value";
function setup(state = "stopped", o: { start?: () => unknown; tasks?: string[]; tokens?: string[] } = {}) {
  let now = 1_800_000_000_000;
  const sent: object[] = [];
  const tokens = [...(o.tokens ?? ["tok-123"])];
  const client = (answer: (c: object) => unknown): Sender => ({ send: async (c) => (sent.push(c), answer(c)) });
  const h = makeHandler({
    ec2: client((c) => {
      if (c instanceof DescribeInstancesCommand) return { Reservations: [{ Instances: [{ State: { Name: state } }] }] };
      if (c instanceof StartInstancesCommand && o.start) return o.start();
      if (c instanceof DescribeReplaceRootVolumeTasksCommand) return { ReplaceRootVolumeTasks: (o.tasks ?? []).map((TaskState) => ({ TaskState })) };
      if (c instanceof CreateReplaceRootVolumeTaskCommand) return { ReplaceRootVolumeTask: { ReplaceRootVolumeTaskId: "replacevol-1" } };
      return {};
    }),
    // each read of the start token takes the next value (a rotation between two reads)
    ssm: client((c) => ({ Parameter: { Value: (c as GetParameterCommand).input.Name === "/switchboard/edge-header" ? EDGE : tokens.length > 1 ? tokens.shift() : tokens[0] } })),
    instanceId: "i-0abc",
    tokenParam: "/switchboard/start-token",
    now: () => now,
  });
  const call = (method: string, rawPath: string, token?: string, edge: string | null = EDGE) =>
    h({ rawPath, requestContext: { http: { method } }, headers: { ...(token === undefined ? {} : { "x-switchboard-start-token": token }), ...(edge === null ? {} : { "x-switchboard-edge": edge }) } } satisfies UrlEvent);
  return { sent, call, advance: (ms: number) => (now += ms) };
}

/** The start page's own start() (aws/auth-page.html), run with a fake clock, api, sleep and button (review #456). */
async function runStart(answers: Array<() => unknown>, o: { sleepFor?: (ms: number) => number } = {}) {
  const page = await Bun.file(new URL("./auth-page.html", import.meta.url)).text();
  const src = page.slice(page.indexOf("const START_WAIT_MS"), page.indexOf("async function rebuild"));
  let now = 0;
  const calls: number[] = [];
  const said: Array<{ text: string; bad?: boolean }> = [];
  const button = { disabled: false };
  let daemon = false;
  const api = async () => (calls.push(now), answers[Math.min(calls.length, answers.length) - 1]!());
  const sleep = async (ms: number) => void (now += o.sleepFor ? o.sleepFor(ms) : ms);
  // withRecent (the passkey check, #497) passes through: auth.test.ts covers it
  const start = new Function("api", "sleep", "say", "$", "waitForDaemon", "Date", "withRecent", `${src}\nreturn start;`)(
    api, sleep, (text: string, bad?: boolean) => said.push({ text, bad }), () => button, async () => void (daemon = true), { now: () => now }, (send: () => unknown) => send(),
  ) as () => Promise<void>;
  await start();
  return { calls, said, last: said.at(-1), button, daemon };
}
const refused = (reason?: string) => () => { throw Object.assign(new Error("AWS に今この型の Spot の空きがありません"), { status: 409, reason }); };

describe("aws/starter.ts (#231)", () => {
  test("GET /status answers the instance's state without a token; stopping stays stopping (review #344)", async () => {
    const { call } = setup("running");
    const r = await call("GET", "/status");
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ state: "running" });
    expect(JSON.parse((await setup("stopping").call("GET", "/status")).body)).toEqual({ state: "stopping" });
  });

  test("POST /start with the token starts the one instance, once", async () => {
    const { sent, call } = setup();
    const r = await call("POST", "/start", "tok-123");
    expect(r.statusCode).toBe(202);
    const starts = sent.filter((c) => c instanceof StartInstancesCommand) as StartInstancesCommand[];
    expect(starts).toHaveLength(1);
    expect(starts[0]!.input).toEqual({ InstanceIds: ["i-0abc"] });
    const read = sent.find((c) => c instanceof GetParameterCommand && c.input.Name === "/switchboard/start-token") as GetParameterCommand;
    expect(read.input).toEqual({ Name: "/switchboard/start-token", WithDecryption: true });
  });

  test("a start right after a stop, before the Spot request is startable again, is 409 so the page waits and retries (#211)", async () => {
    const { call } = setup("stopped", { start: () => { throw awsError("IncorrectSpotRequestState", "You can't start the Spot Instance because the associated Spot Instance request is not in an appropriate state to support start."); } });
    const r = await call("POST", "/start", "tok-123");
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain("止まった直後");
    // the page waits and retries it: "the other 409s keep their 5 s wait" below runs the page's own start()
  });

  test("a start while the machine is still stopping is 409 with a message, not a bare 502 (review #344)", async () => {
    const { call } = setup("stopping", { start: () => { throw awsError("IncorrectInstanceState", "The instance is not in a state from which it can be started."); } });
    const r = await call("POST", "/start", "tok-123");
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain("停止の途中");
    // anything else still fails loudly
    const other = setup("stopped", { start: () => { throw awsError("UnauthorizedOperation", "no"); } });
    await expect(other.call("POST", "/start", "tok-123")).rejects.toThrow("no");
  });

  test("a start refused for Spot capacity is 409 with reason capacity, not a Lambda error (#443)", async () => {
    const { call } = setup("stopped", { start: () => { throw awsError("InsufficientInstanceCapacity", "You can't start the Spot Instance 'i-0abc' because there is no available Spot capacity."); } });
    const r = await call("POST", "/start", "tok-123");
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.reason).toBe("capacity");
    expect(body.error).toContain("Spot の空きがありません");
    const page = await Bun.file(new URL("./auth-page.html", import.meta.url)).text();
    expect(page).toContain("{ status: r.status, reason: data.reason }"); // the page keeps the reason
    expect(page).toContain('e?.name === "NotAllowedError"'); // closing the passkey sheet is a cancel, not the browser's "timed out" (#863)
    expect(page.match(/\.catch\(cancelled\)/g)).toHaveLength(2); // both ceremonies: register and the passkey check
  });

  test("the page tries again every 15 s while capacity is short, and stops at 3 minutes with the button back (#443, review #456)", async () => {
    const r = await runStart([refused("capacity")]);
    expect(r.calls).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000, 135_000, 150_000, 165_000]); // none at 180 s
    expect(r.said[0]!.text).toContain("Spot の空き待ち… 0 秒（3 分まで待ちます）");
    expect(r.last).toEqual({ text: "AWS に今この型の Spot の空きがありません。3 分待っても空きませんでした。時間をおいてもう一度押してください", bad: true });
    expect(r.button.disabled).toBe(false);
    expect(r.daemon).toBe(false);
  });

  test("the page goes on when capacity comes back, and a tab suspended past the deadline does not try again (review #456)", async () => {
    const back = await runStart([refused("capacity"), refused("capacity"), () => ({ started: true })]);
    expect(back.calls).toEqual([0, 15_000, 30_000]);
    expect(back.daemon).toBe(true);
    const suspended = await runStart([refused("capacity"), () => ({ started: true })], { sleepFor: () => 300_000 });
    expect(suspended.calls).toEqual([0]);
    expect(suspended.daemon).toBe(false);
    expect(suspended.last?.text).toContain("3 分待っても空きませんでした");
    // the other 409s keep their 5 s wait and their own message; anything else stops at once
    const stopping = await runStart([refused(), () => ({ started: true })]);
    expect(stopping.calls).toEqual([0, 5000]);
    const other = await runStart([() => { throw Object.assign(new Error("HTTP 500"), { status: 500 }); }]);
    expect(other.calls).toEqual([0]);
    expect(other.last).toEqual({ text: "HTTP 500", bad: true });
  });

  test("POST /rebuild on a running instance replaces its root volume in place: no stack update, no Spot cancel (re-review #338)", async () => {
    const { sent, call } = setup("running");
    const r = await call("POST", "/rebuild", "tok-123");
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ rebuilding: true, task: "replacevol-1" });
    const replace = sent.filter((c) => c instanceof CreateReplaceRootVolumeTaskCommand) as CreateReplaceRootVolumeTaskCommand[];
    expect(replace.map((c) => c.input)).toEqual([{ InstanceId: "i-0abc", DeleteReplacedRootVolume: true }]);
    expect(sent.map((c) => c.constructor.name).filter((n) => /Stack|Spot/.test(n))).toEqual([]);
  });

  test("a rebuild of a stopped machine, or during a replacement, is 409 and replaces nothing (re-review #338)", async () => {
    for (const [state, tasks, words] of [["stopped", [], "先に起動"], ["running", ["in-progress"], "作り直しの途中"]] as const) {
      const { sent, call } = setup(state, { tasks: [...tasks] });
      const r = await call("POST", "/rebuild", "tok-123");
      expect(r.statusCode).toBe(409);
      expect(JSON.parse(r.body).error).toContain(words);
      expect(sent.some((c) => c instanceof CreateReplaceRootVolumeTaskCommand)).toBe(false);
    }
    // a finished replacement does not hold the next one
    expect((await setup("running", { tasks: ["succeeded", "failed"] }).call("POST", "/rebuild", "tok-123")).statusCode).toBe(202);
  });

  test("a rotated token works at once: a mismatch reads the parameter again (review #344)", async () => {
    const { call, advance } = setup("stopped", { tokens: ["old-tok", "new-tok"] });
    expect((await call("POST", "/start", "old-tok")).statusCode).toBe(202);
    advance(FORCED_REREAD_MS);
    expect((await call("POST", "/start", "new-tok")).statusCode).toBe(202);
  });

  test("wrong start tokens re-read SSM at most once per FORCED_REREAD_MS", async () => {
    const { sent, call, advance } = setup("stopped", { tokens: ["tok-1", "tok-2"] });
    const reads = () => sent.filter((c) => c instanceof GetParameterCommand).length;
    for (let i = 0; i < 100; i++) expect((await call("POST", "/start", "guess")).statusCode).toBe(403);
    expect(reads()).toBeLessThanOrEqual(10); // the edge header once, the token once (the forced re-read is held back)
    advance(FORCED_REREAD_MS); // the user rotated the token meanwhile: the next try reads it again and passes
    expect((await call("POST", "/start", "tok-2")).statusCode).toBe(202);
    expect(reads()).toBeLessThanOrEqual(12);
  });

  test("a request without the edge header gets 403 on every path, /status included", async () => {
    const { sent, call } = setup("running");
    for (const [m, p] of [["GET", "/status"], ["POST", "/start"], ["POST", "/rebuild"], ["GET", "/_auth/status"], ["GET", "/elsewhere"]] as const) {
      expect((await call(m, p, "tok-123", null)).statusCode).toBe(403);
      expect((await call(m, p, "tok-123", "wrong-value-here!")).statusCode).toBe(403);
    }
    expect(sent.filter((c) => !(c instanceof GetParameterCommand))).toEqual([]); // nothing reached EC2
    expect((await call("GET", "/status")).statusCode).toBe(200);
  });

  test("a missing or wrong token is 403 and sends nothing to EC2; unknown routes are 404", async () => {
    const { sent, call } = setup();
    expect((await call("POST", "/start")).statusCode).toBe(403);
    expect((await call("POST", "/rebuild", "tok-12X")).statusCode).toBe(403);
    expect(sent.filter((c) => !(c instanceof GetParameterCommand))).toEqual([]);
    expect((await call("GET", "/start")).statusCode).toBe(404);
    expect((await call("POST", "/elsewhere", "tok-123")).statusCode).toBe(404);
  });
});

describe("scheduled event (#1639)", () => {
  test("a scheduled event runs reconcile", async () => {
    let reconciled = 0;
    const h = makeHandler({
      ec2: { send: async () => ({}) },
      ssm: { send: async () => ({ Parameter: { Value: "EDIST" } }) },
      instanceId: "i-0abc",
      tokenParam: "/t",
      auth: {
        bucket: "b",
        publicOrigin: "https://x",
        s3: { send: async () => (reconciled++, { ETag: "x", Body: { transformToString: async () => "null" } }) },
      },
      countries: { cloudfront: { send: async () => ({}) }, base: ["JP"] },
    });
    expect(await h({ source: "aws.events" })).toEqual({ ok: true });
    expect(reconciled).toBe(1); // it read the allowance (none: no CloudFront call)
  });
});
