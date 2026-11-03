/**
 * The versions aws/host/node.sh and aws/host/devtools.sh pin, against the distributors' latest (PBI #3345). Detection
 * only: the pins are those two files' lines, read here and not copied, and nothing here changes them. Node.js also says
 * whether a newer release of the pinned major is a security release. No key: the GitHub reads are unauthenticated, so
 * its rate limit reads as "cannot tell".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareRpm, newest } from "./host-updates.ts";

export type Source = { kind: "node" } | { kind: "docker" } | { kind: "github"; repo: string } | { kind: "npm"; pkg: string };

export interface Pin {
  name: string;
  pinned: string;
  source: Source;
}

/** Each pin's variable, and where its releases are. The version itself is only ever in the shell script. */
const NODE_PINS: Record<string, Source> = { NODE_VERSION: { kind: "node" } };
const DEVTOOLS_PINS: Record<string, Source> = {
  DOCKER_VERSION: { kind: "docker" },
  COMPOSE_VERSION: { kind: "github", repo: "docker/compose" },
  UV_VERSION: { kind: "github", repo: "astral-sh/uv" },
  GITLEAKS_VERSION: { kind: "github", repo: "gitleaks/gitleaks" },
  SAM_VERSION: { kind: "github", repo: "aws/aws-sam-cli" },
  PLAYWRIGHT_VERSION: { kind: "npm", pkg: "playwright" },
  PLAYWRIGHT_MCP_VERSION: { kind: "npm", pkg: "@playwright/mcp" },
  GH_STACK_VERSION: { kind: "github", repo: "github/gh-stack" },
};

const PLAIN = /^\d+(\.\d+)+$/;
const plain = (v: string) => v.replace(/^v/, "");

/** The pins of the two scripts; a variable that is not there, or not a version, is in `unreadable`: never dropped quietly. */
export function readPins(nodeSh: string, devtoolsSh: string): { pins: Pin[]; unreadable: string[] } {
  const out = { pins: [] as Pin[], unreadable: [] as string[] };
  for (const [text, table] of [[nodeSh, NODE_PINS], [devtoolsSh, DEVTOOLS_PINS]] as const) {
    for (const [name, source] of Object.entries(table)) {
      const m = new RegExp(`^${name}=(\\S+)$`, "m").exec(text);
      if (m && PLAIN.test(plain(m[1]!))) out.pins.push({ name, pinned: plain(m[1]!), source });
      else out.unreadable.push(name);
    }
  }
  return out;
}

export type FetchText = (url: string) => Promise<string>;

export interface Latest {
  latest: string;
  security?: boolean;
}

function newestOf(versions: string[]): string {
  const best = newest(versions);
  if (best === null) throw new Error("版が 1 つも無い");
  return best;
}

/** The newest release. Throws when the distributor cannot be read or shows none: the caller says "cannot tell". */
export async function latestOf(pin: Pin, fetchText: FetchText): Promise<Latest> {
  const { source } = pin;
  if (source.kind === "node") {
    const major = pin.pinned.split(".")[0];
    const rows = (JSON.parse(await fetchText("https://nodejs.org/dist/index.json")) as { version: string; lts: unknown; security?: boolean }[])
      .map((r) => ({ ...r, version: plain(r.version) }))
      .filter((r) => r.lts && r.version.split(".")[0] === major);
    return { latest: newestOf(rows.map((r) => r.version)), security: rows.some((r) => r.security === true && compareRpm(r.version, pin.pinned) > 0) };
  }
  if (source.kind === "docker") {
    const page = await fetchText("https://download.docker.com/linux/static/stable/aarch64/");
    return { latest: newestOf([...page.matchAll(/href="docker-(\d+(?:\.\d+)+)\.tgz"/g)].map((m) => m[1]!)) };
  }
  if (source.kind === "npm") {
    const { version } = JSON.parse(await fetchText(`https://registry.npmjs.org/${source.pkg}/latest`)) as { version?: unknown };
    if (typeof version !== "string" || !PLAIN.test(version)) throw new Error(`${source.pkg}: 版が読めない`);
    return { latest: version };
  }
  const { tag_name } = JSON.parse(await fetchText(`https://api.github.com/repos/${source.repo}/releases/latest`)) as { tag_name?: unknown };
  if (typeof tag_name !== "string") throw new Error(`${source.repo}: 版が読めない`);
  // releases/latest leaves out what is marked pre-release; one that is not marked cannot be compared, so it is "cannot tell"
  if (!PLAIN.test(plain(tag_name))) throw new Error(`${source.repo}: pre-release らしい tag: ${tag_name}`);
  return { latest: plain(tag_name) };
}

export interface Outdated {
  name: string;
  pinned: string;
  latest: string;
  security?: boolean;
}

export function outdatedPins(pins: Pin[], latest: Record<string, Latest>): Outdated[] {
  const out: Outdated[] = [];
  for (const p of pins) {
    const l = latest[p.name];
    if (!l || compareRpm(p.pinned, l.latest) >= 0) continue;
    out.push({ name: p.name, pinned: p.pinned, latest: l.latest, ...(l.security && { security: true }) });
  }
  return out;
}

export class PinsUnreadable extends Error {}

/** One read of all the pins. Throws PinsUnreadable when a pin or a distributor cannot be read: partial results must not read as "up to date". */
export async function readPinsOutdated(fetchText: FetchText = hostFetch, repo = join(import.meta.dir, "..")): Promise<Outdated[]> {
  const { pins, unreadable } = readPins(readFileSync(join(repo, "aws/host/node.sh"), "utf8"), readFileSync(join(repo, "aws/host/devtools.sh"), "utf8"));
  const why = unreadable.map((n) => `${n}: 固定の行が読めない`);
  const latest: Record<string, Latest> = {};
  await Promise.all(
    pins.map(async (p) => {
      try {
        latest[p.name] = await latestOf(p, fetchText);
      } catch (e) {
        why.push(`${p.name}: ${(e as Error).message}`);
      }
    }),
  );
  if (why.length) throw new PinsUnreadable(why.sort().join(" / "));
  return outdatedPins(pins, latest);
}

/** One GET, 10 s, no key. */
export async function hostFetch(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.text();
}
