import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one way this code reads and writes the uplink bucket: the deltas a work machine sends (uplink-s3.ts), the backlog
 * edits it made (backlog-upbox.ts) and the PBI leases (lease.ts) all go through it, so there is one place that knows
 * how S3 is asked and one fake for every test (`memoryS3`).
 *
 * A write may carry a condition, and S3 decides it atomically: `ifNoneMatch` writes only a key that is not there,
 * `ifMatch` only over the version with that etag. A write whose condition does not hold answers `"conflict"` and
 * changes nothing. Nothing is ever deleted through this interface (the credentials have no delete either).
 */
export interface S3Store {
  /**
   * The object under `key`, or null when there is none. With `maxBytes` no more than that much of it is fetched or
   * held, whatever lies under the key (`more` = the object is bigger than that): the limit is in the request itself,
   * not a check after the whole object was brought here.
   */
  get(key: string, opts?: { maxBytes?: number }): Promise<{ body: Uint8Array; etag: string; more?: true } | null>;
  put(key: string, body: Uint8Array, cond?: { ifNoneMatch: true } | { ifMatch: string }): Promise<{ etag: string } | "conflict">;
  /** Every key under `prefix` (after `after`, when given), in key order, with its etag and its size in bytes (so a reader can refuse an object before it fetches it). */
  list(prefix: string, after?: string): Promise<Array<{ key: string; etag: string; size: number }>>;
}

/** An S3 kept in memory with the same conditions; `calls` counts every request, for a test that wants none made, and `largestRead` is the most bytes one `get` handed out. */
export function memoryS3(): S3Store & { calls: number; largestRead: number; objects: Map<string, { body: Uint8Array; etag: string }> } {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let version = 0;
  const store = {
    calls: 0,
    largestRead: 0,
    objects,
    async get(key: string, opts?: { maxBytes?: number }) {
      store.calls++;
      const o = objects.get(key);
      if (!o) return null;
      const more = opts?.maxBytes !== undefined && o.body.length > opts.maxBytes;
      const body = more ? o.body.slice(0, opts!.maxBytes) : o.body;
      store.largestRead = Math.max(store.largestRead, body.length);
      return { body, etag: o.etag, ...(more ? { more: true as const } : {}) };
    },
    async put(key: string, body: Uint8Array, cond?: { ifNoneMatch: true } | { ifMatch: string }) {
      store.calls++;
      const had = objects.get(key);
      if (cond && "ifNoneMatch" in cond && had) return "conflict" as const;
      if (cond && "ifMatch" in cond && had?.etag !== cond.ifMatch) return "conflict" as const;
      const etag = `"v${++version}"`;
      objects.set(key, { body: Uint8Array.from(body), etag });
      return { etag };
    },
    async list(prefix: string, after?: string) {
      store.calls++;
      return [...objects]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, o]) => ({ key, etag: o.etag, size: o.body.length }));
    },
  };
  return store;
}

/** Runs the `aws` CLI; a test passes its own. */
export type AwsRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runAws: AwsRun = async (args) => {
  const p = Bun.spawn(["aws", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

/** What kind of failure the CLI reported, without its text. */
export function awsFailureKind(stderr: string): string {
  const known = /AccessDenied|ExpiredToken|InvalidAccessKeyId|SignatureDoesNotMatch|NoSuchBucket|NoSuchKey|PreconditionFailed|ConditionalRequestConflict|SlowDown|RequestTimeout|Unable to locate credentials|Could not connect|Unknown options/.exec(stderr)?.[0];
  return known ?? "the request did not succeed";
}

/** The conditions S3 refuses a write with: the key is there (412), or another write of the key was under way (409). */
const REFUSED = /PreconditionFailed|ConditionalRequestConflict|\(412\)|\(409\)/;
const MISSING = /NoSuchKey|Not Found|\(404\)/;
const EMPTY_RANGE = /InvalidRange|\(416\)/;

/**
 * The bucket through the `aws` CLI the host already has (no SDK is added): `s3api get-object` / `put-object` /
 * `list-objects-v2`, with the machine's own credentials and region. `bucket` is asked for at the first call, so a
 * daemon that never uses the store never looks its name up.
 */
export function awsS3(bucket: string | (() => Promise<string>), run: AwsRun = runAws): S3Store {
  let name: Promise<string> | undefined;
  const at = () => (name ??= typeof bucket === "string" ? Promise.resolve(bucket) : bucket());
  const call = async (args: string[]) => {
    const r = await run(args);
    return r;
  };
  // only the kind of failure leaves this module: the CLI's own text names the role (with its account) and the bucket,
  // and what is thrown here ends in logs, in stored notes and in API answers
  const fail = (what: string, r: { code: number; stderr: string }) => new Error(`aws ${what.split(" ")[0]} failed (${r.code}): ${awsFailureKind(r.stderr)}`);
  const scratch = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.s3."));
    try {
      return await use(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    get: (key, opts) =>
      scratch(async (dir) => {
        const out = join(dir, "body");
        const max = opts?.maxBytes;
        // one byte past the limit is asked for, so a bigger object is told from one of exactly the limit
        const ask = async (range: string[]) => call(["s3api", "get-object", "--bucket", await at(), "--key", key, ...range, "--output", "json", out]);
        let r = await ask(max !== undefined ? ["--range", `bytes=0-${max}`] : []);
        // an empty object has no first byte to ask for: it is read as it is
        if (r.code !== 0 && max !== undefined && EMPTY_RANGE.test(r.stderr)) r = await ask([]);
        if (r.code !== 0) {
          if (MISSING.test(r.stderr)) return null;
          throw fail(`get-object ${key}`, r);
        }
        const read = new Uint8Array(readFileSync(out));
        const etag = String((JSON.parse(r.stdout) as { ETag?: string }).ETag ?? "");
        return max !== undefined && read.length > max ? { body: read.slice(0, max), etag, more: true as const } : { body: read, etag };
      }),
    put: (key, body, cond) =>
      scratch(async (dir) => {
        const file = join(dir, "body");
        writeFileSync(file, body, { mode: 0o600 });
        const when = !cond ? [] : "ifNoneMatch" in cond ? ["--if-none-match", "*"] : ["--if-match", cond.ifMatch];
        const r = await call(["s3api", "put-object", "--bucket", await at(), "--key", key, "--body", file, ...when, "--output", "json"]);
        if (r.code !== 0) {
          if (cond && REFUSED.test(r.stderr)) return "conflict";
          throw fail(`put-object ${key}`, r);
        }
        return { etag: String((JSON.parse(r.stdout) as { ETag?: string }).ETag ?? "") };
      }),
    list: async (prefix, after) => {
      const r = await call(["s3api", "list-objects-v2", "--bucket", await at(), "--prefix", prefix, ...(after ? ["--start-after", after] : []), "--query", "Contents[].{key:Key,etag:ETag,size:Size}", "--output", "json"]);
      if (r.code !== 0) throw fail(`list-objects-v2 ${prefix}`, r);
      const found = JSON.parse(r.stdout.trim() || "null") as Array<{ key: string; etag: string; size?: number }> | null;
      // a size that was not answered counts as too big for any limit
      return (found ?? []).map((o) => ({ key: String(o.key), etag: String(o.etag), size: typeof o.size === "number" ? o.size : Number.POSITIVE_INFINITY })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
  };
}

/** The uplink bucket's name on the instance, where the template wrote it (the host's start-up script is not changed for it). */
export const UPLINK_BUCKET_PARAMETER = "/switchboard/uplink-bucket";

export async function bucketFromParameter(run: AwsRun = runAws): Promise<string> {
  const r = await run(["ssm", "get-parameter", "--name", UPLINK_BUCKET_PARAMETER, "--query", "Parameter.Value", "--output", "text"]);
  const name = r.stdout.trim();
  if (r.code !== 0 || !name) throw new Error(`the uplink bucket is not set: SWITCHBOARD_UPLINK_BUCKET is empty and ${UPLINK_BUCKET_PARAMETER} cannot be read (${awsFailureKind(r.stderr)})`);
  return name;
}
