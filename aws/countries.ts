/**
 * Temporary extra countries for the distribution's geo restriction (#1639). One allowance at a time, kept as
 * `auth/countries.json` in the data bucket (like auth/passkeys.json). `reconcile` makes CloudFront's whitelist
 * `base ∪ (allowance while it is in force)`; the Starter runs it every 5 minutes (the expiry and a redeploy that put the
 * whitelist back are both fixed by that one path) and after every set / clear. `base` (the stack's AllowedCountries) is
 * never changed here; empty = no geo restriction, and nothing is touched.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetDistributionConfigCommand, UpdateDistributionCommand } from "@aws-sdk/client-cloudfront";

export interface Sender {
  send(command: object): Promise<unknown>;
}
export interface Allowance {
  countries: string[];
  from: number;
  until: number;
  setAt: number;
  /** Set by the first run that applied it: a whitelist found without it later was put back by someone else (a redeploy). */
  applied?: boolean;
}
export const MAX_ALLOWANCE_MS = 90 * 24 * 3600_000;
const MAX_COUNTRIES = 10;
const KEY = "auth/countries.json";
const DISTRIBUTION_PARAM = "/switchboard/distribution-id";
const PARAM_TTL_MS = 60_000;

/** A request body → an allowance, or a message the page can show as it is. `from` defaults to now. */
export function parseAllowance(v: unknown, now: number): Allowance | { error: string } {
  const o = (v && typeof v === "object" ? v : {}) as { countries?: unknown; from?: unknown; until?: unknown };
  if (!Array.isArray(o.countries) || o.countries.length === 0) return { error: "国を 1 つ以上指定してください" };
  if (!o.countries.every((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c))) return { error: "国は 2 文字の大文字（ISO 3166-1 alpha-2。例: US）で指定してください" };
  const countries = [...new Set(o.countries as string[])].sort();
  if (countries.length > MAX_COUNTRIES) return { error: `国は ${MAX_COUNTRIES} 個までです` };
  const from = o.from === undefined ? now : o.from;
  if (typeof from !== "number" || !Number.isFinite(from)) return { error: "開始日時が読めません" };
  if (typeof o.until !== "number" || !Number.isFinite(o.until)) return { error: "終了日時を指定してください（終了の無い設定はできません）" };
  if (o.until <= from) return { error: "終了は開始より後にしてください" };
  if (o.until <= now) return { error: "終了がもう過ぎています" };
  if (o.until - from > MAX_ALLOWANCE_MS) return { error: "期間は 90 日までです" };
  return { countries, from, until: o.until, setAt: now };
}

export function makeCountries(d: { cloudfront: Sender; s3: Sender; ssm: Sender; bucket: string; base: string[]; now?: () => number }) {
  const now = d.now ?? Date.now;
  const base = [...new Set(d.base)].sort();
  let dist: { id: string; at: number } | undefined;
  const distributionId = async () => {
    if (!dist || now() - dist.at > PARAM_TTL_MS) {
      const r = (await d.ssm.send(new GetParameterCommand({ Name: DISTRIBUTION_PARAM }))) as { Parameter?: { Value?: string } };
      if (!r.Parameter?.Value) throw new Error("distribution id is not set");
      dist = { id: r.Parameter.Value, at: now() };
    }
    return dist.id;
  };
  const load = async (): Promise<{ a: Allowance | null; etag?: string }> => {
    try {
      const r = (await d.s3.send(new GetObjectCommand({ Bucket: d.bucket, Key: KEY }))) as { ETag?: string; Body?: { transformToString(): Promise<string> } };
      return { a: (JSON.parse((await r.Body?.transformToString()) ?? "null") as Allowance | null) ?? null, etag: r.ETag };
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return { a: null };
      throw e;
    }
  };
  const log = (action: string, countries: string[], a?: Allowance | null) =>
    console.log(JSON.stringify({ log: "countries", t: new Date(now()).toISOString(), action, countries, from: a?.from ?? null, until: a?.until ?? null }));
  const inForce = (a: Allowance | null) => !!a && a.from <= now() && now() < a.until;
  const desired = (a: Allowance | null): string[] | null => (base.length === 0 ? null : [...new Set([...base, ...(inForce(a) ? a!.countries : [])])].sort());

  /** Makes CloudFront's whitelist match; returns what it did ("" = nothing to change). */
  async function reconcile(): Promise<"" | "apply" | "revert" | "restore"> {
    const { a, etag } = await load();
    const want = desired(a);
    if (!a || !want) return "";
    const id = await distributionId();
    const got = (await d.cloudfront.send(new GetDistributionConfigCommand({ Id: id }))) as { ETag?: string; DistributionConfig?: { Restrictions?: { GeoRestriction?: { RestrictionType?: string; Items?: string[] } } } };
    const cfg = got.DistributionConfig;
    if (!cfg) return "";
    const geo = cfg.Restrictions?.GeoRestriction;
    const have = [...(geo?.Items ?? [])].sort();
    let did: "" | "apply" | "revert" | "restore" = "";
    if (geo?.RestrictionType !== "whitelist" || have.join() !== want.join()) {
      try {
        await d.cloudfront.send(new UpdateDistributionCommand({ Id: id, IfMatch: got.ETag, DistributionConfig: { ...cfg, Restrictions: { ...cfg.Restrictions, GeoRestriction: { RestrictionType: "whitelist", Quantity: want.length, Items: want } } } as never }));
      } catch (e) {
        if ((e as { name?: string }).name === "PreconditionFailed") return ""; // the next run reads it again
        throw e;
      }
      // in the window: "apply" the first time; once it was applied, finding the extra countries gone again is a "restore"
      did = !inForce(a) ? "revert" : a.applied ? "restore" : "apply";
      log(did, a.countries, a);
    }
    // the mark, also when CloudFront already matched (an allowance replaced by a longer one): best effort, a lost mark only logs "apply" again
    if (inForce(a) && !a.applied) await d.s3.send(new PutObjectCommand({ Bucket: d.bucket, Key: KEY, Body: JSON.stringify({ ...a, applied: true }), ContentType: "application/json", ...(etag ? { IfMatch: etag } : {}) })).catch(() => {});
    // finished and CloudFront is back to the base: the record is no longer needed. Only the version read above: a new
    // allowance saved meanwhile has another ETag and stays (the next run reads it)
    if (now() >= a.until) {
      try {
        await d.s3.send(new DeleteObjectCommand({ Bucket: d.bucket, Key: KEY, ...(etag ? { IfMatch: etag } : {}) }));
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 412 && status !== 409 && (e as { name?: string }).name !== "PreconditionFailed") throw e;
      }
    }
    return did;
  }

  return {
    base,
    async view(): Promise<{ base: string[]; allowance: Allowance | null; active: boolean }> {
      const { a } = await load();
      const live = a && now() < a.until ? a : null; // an ended one waits for its cleanup only
      return { base, allowance: live, active: inForce(live) };
    },
    async set(a: Allowance): Promise<void> {
      const { etag } = await load();
      await d.s3.send(new PutObjectCommand({ Bucket: d.bucket, Key: KEY, Body: JSON.stringify(a), ContentType: "application/json", ...(etag ? { IfMatch: etag } : {}) }));
      log("set", a.countries, a);
      await reconcile();
    },
    /** Ends the allowance now: the record stays (expired) until CloudFront is back to the base, so a failure here is finished by the next run. */
    async clear(): Promise<void> {
      const { a, etag } = await load();
      if (!a) return;
      const t = now();
      const ended: Allowance = { ...a, from: Math.min(a.from, t), until: t };
      await d.s3.send(new PutObjectCommand({ Bucket: d.bucket, Key: KEY, Body: JSON.stringify(ended), ContentType: "application/json", ...(etag ? { IfMatch: etag } : {}) }));
      log("clear", a.countries, a);
      await reconcile();
    },
    reconcile,
  };
}
