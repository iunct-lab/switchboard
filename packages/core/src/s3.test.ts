// test-reads: none
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { awsS3, bucketFromParameter, memoryS3, runCommand, type AwsRun } from "./s3.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("memoryS3", () => {
  test("a write with ifNoneMatch makes a key once; a second one changes nothing", async () => {
    const s3 = memoryS3();
    expect(await s3.put("a/1", bytes("one"), { ifNoneMatch: true })).toEqual({ etag: expect.any(String) });
    expect(await s3.put("a/1", bytes("two"), { ifNoneMatch: true })).toBe("conflict");
    expect(text((await s3.get("a/1"))!.body)).toBe("one");
  });

  test("a write with ifMatch goes only over the version read", async () => {
    const s3 = memoryS3();
    const first = (await s3.put("k", bytes("1"))) as { etag: string };
    const second = (await s3.put("k", bytes("2"), { ifMatch: first.etag })) as { etag: string };
    expect(second.etag).not.toBe(first.etag);
    expect(await s3.put("k", bytes("3"), { ifMatch: first.etag })).toBe("conflict");
    expect(await s3.put("none", bytes("3"), { ifMatch: first.etag })).toBe("conflict");
    expect(text((await s3.get("k"))!.body)).toBe("2");
  });

  test("list answers the keys under a prefix in order, after a key when asked, and every request is counted", async () => {
    const s3 = memoryS3();
    for (const k of ["p/b", "p/a", "q/a", "p/c"]) await s3.put(k, bytes(k));
    expect((await s3.list("p/")).map((o) => o.key)).toEqual(["p/a", "p/b", "p/c"]);
    expect((await s3.list("p/", "p/a")).map((o) => o.key)).toEqual(["p/b", "p/c"]);
    expect(await s3.get("p/none")).toBeNull();
    expect(s3.calls).toBe(7);
  });
});

describe("awsS3", () => {
  /** A fake `aws`: records the arguments and answers as told. */
  const fake = (answer: (args: string[]) => { code?: number; stdout?: string; stderr?: string }) => {
    const seen: string[][] = [];
    const run: AwsRun = async (args) => {
      seen.push(args);
      return { code: 0, stdout: "", stderr: "", ...answer(args) };
    };
    return { run, seen };
  };

  test("put passes the condition to the CLI and reads a refused condition as a conflict, any other failure as an error", async () => {
    let body = "";
    const ok = fake((args) => ((body = readFileSync(args[args.indexOf("--body") + 1]!, "utf8")), { stdout: '{"ETag":"\\"e1\\""}' }));
    expect(await awsS3("b", ok.run).put("k", bytes("hello"), { ifNoneMatch: true })).toEqual({ etag: '"e1"' });
    expect(body).toBe("hello");
    expect(ok.seen[0]!.slice(0, 6)).toEqual(["s3api", "put-object", "--bucket", "b", "--key", "k"]);
    expect(ok.seen[0]).toContain("--if-none-match");
    await awsS3("b", ok.run).put("k", bytes("x"), { ifMatch: '"e1"' });
    expect(ok.seen[1]!.slice(ok.seen[1]!.indexOf("--if-match"), ok.seen[1]!.indexOf("--if-match") + 2)).toEqual(["--if-match", '"e1"']);
    await awsS3("b", ok.run).put("k", bytes("x"));
    expect(ok.seen[2]!.some((a) => a.startsWith("--if-"))).toBe(false);

    const refused = fake(() => ({ code: 254, stderr: "An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold" }));
    expect(await awsS3("b", refused.run).put("k", bytes("x"), { ifNoneMatch: true })).toBe("conflict");
    const denied = fake(() => ({ code: 254, stderr: "An error occurred (AccessDenied) when calling the PutObject operation" }));
    await expect(awsS3("b", denied.run).put("k", bytes("x"), { ifNoneMatch: true })).rejects.toThrow("AccessDenied");
  });

  test("get answers null for a key that is not there, and the bucket's name is asked for once, at the first call", async () => {
    let asked = 0;
    const none = fake(() => ({ code: 254, stderr: "An error occurred (NoSuchKey) when calling the GetObject operation" }));
    const s3 = awsS3(async () => (asked++, "named"), none.run);
    expect(asked).toBe(0);
    expect(await s3.get("k")).toBeNull();
    expect(await s3.get("k")).toBeNull();
    expect(asked).toBe(1);
    expect(none.seen[0]!.slice(0, 6)).toEqual(["s3api", "get-object", "--bucket", "named", "--key", "k"]);
  });

  test("a bucket name that could not be looked up is asked for again at the next call", async () => {
    let asked = 0;
    const none = fake(() => ({ code: 254, stderr: "An error occurred (NoSuchKey) when calling the GetObject operation" }));
    const s3 = awsS3(async () => { if (++asked === 1) throw new Error("did not answer within 20 s"); return "named"; }, none.run);
    await expect(s3.get("k")).rejects.toThrow("did not answer");
    expect(await s3.get("k")).toBeNull();
    expect(asked).toBe(2);
    expect(none.seen[0]!.slice(0, 4)).toEqual(["s3api", "get-object", "--bucket", "named"]);
  });

  test("get with a byte limit asks S3 for that much only, and says when the object is bigger", async () => {
    // the fake answers what S3 would for the range asked: at most the bytes of the range
    const object = Buffer.alloc(1024 * 1024, "x");
    const ranged = fake((args) => {
      const range = /^bytes=0-(\d+)$/.exec(args[args.indexOf("--range") + 1] ?? "");
      writeFileSync(args[args.length - 1]!, range ? object.subarray(0, Number(range[1]) + 1) : object);
      return { stdout: '{"ETag":"\\"e1\\""}' };
    });
    const got = await awsS3("b", ranged.run).get("lease/o/r/7.json", { maxBytes: 4096 });
    expect(ranged.seen[0]).toEqual(expect.arrayContaining(["--range", "bytes=0-4096"]));
    expect([got!.body.length, got!.more, got!.etag]).toEqual([4096, true, '"e1"']);
    // an object within the limit is whole, and an empty one (S3 refuses any range of it) is read without the range
    const small = fake((args) => (writeFileSync(args[args.length - 1]!, "{}"), { stdout: '{"ETag":"\\"e2\\""}' }));
    expect(await awsS3("b", small.run).get("k", { maxBytes: 4096 })).toEqual({ body: bytes("{}"), etag: '"e2"' });
    const empty = fake((args) => (args.includes("--range") ? { code: 254, stderr: "An error occurred (InvalidRange) when calling the GetObject operation" } : (writeFileSync(args[args.length - 1]!, ""), { stdout: '{"ETag":"\\"e3\\""}' })));
    expect((await awsS3("b", empty.run).get("k", { maxBytes: 4096 }))!.body.length).toBe(0);
    // without a limit nothing is added to the request
    await awsS3("b", small.run).get("k");
    expect(small.seen[1]).not.toContain("--range");
  });

  test("list sorts what the CLI answers and reads no keys as none", async () => {
    const some = fake(() => ({ stdout: '[{"key":"p/b","etag":"2","size":5},{"key":"p/a","etag":"1"}]' }));
    expect(await awsS3("b", some.run).list("p/", "p/0")).toEqual([{ key: "p/a", etag: "1", size: Number.POSITIVE_INFINITY }, { key: "p/b", etag: "2", size: 5 }]); // a size not answered is over any limit
    expect(some.seen[0]).toContain("--start-after");
    expect(await awsS3("b", fake(() => ({ stdout: "null\n" })).run).list("p/")).toEqual([]);
  });

  test("the instance's bucket name comes from the parameter; an empty answer is an error that says what to set", async () => {
    expect(await bucketFromParameter(fake(() => ({ stdout: "bucket-1\n" })).run)).toBe("bucket-1");
    await expect(bucketFromParameter(fake(() => ({ code: 254, stderr: "ParameterNotFound" })).run)).rejects.toThrow("SWITCHBOARD_UPLINK_BUCKET");
  });
});

describe("the time limit of a request", () => {
  test("a command that has not ended by the limit is killed and the call throws; one that ends in time answers, and none has no limit", async () => {
    const t0 = Date.now();
    await expect(runCommand("sleep", ["30"], 50)).rejects.toThrow("did not answer within");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await runCommand("echo", ["hi"], 5000)).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
    expect((await runCommand("echo", ["hi"])).stdout).toBe("hi\n");
  });

  test("awsS3 hands its limit to every request it makes, and none when it has none", async () => {
    const seen: Array<{ timeoutMs?: number } | undefined> = [];
    const run: AwsRun = async (_args, opts) => (seen.push(opts), { code: 255, stdout: "", stderr: "NoSuchKey" });
    await awsS3("b", run, { timeoutMs: 1234 }).get("k");
    await awsS3("b", run).get("k");
    expect(seen).toEqual([{ timeoutMs: 1234 }, undefined]);
  });
});
