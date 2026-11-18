import { closeSync, createReadStream, openSync, writeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createZstdDecompress } from "node:zlib";
import type { CoreConfig } from "./config.ts";

/**
 * What the instance does with an object a work machine put in the bucket before any of it is believed: the object is
 * input from a machine trusted less than this one (docs/design/work-machine.md, "What the instance takes in").
 *
 *  - It is read with limits: how big the object may be, how big it may become unpacked, how many entries it may hold.
 *    It is unpacked as a stream, so an object that expands without end is cut at the limit instead of filling memory.
 *  - Nothing is written by a name the object gives. The entries are read here (not by an archive library), only plain
 *    files are accepted, and each goes to a numbered file in the stage; where it ends up is decided by `placeOf`.
 *  - A file's name has one of two shapes, and no other is accepted: an attachment of a Task
 *    (`attachments/<task>/<file>`) or a file of a Task's artifact (`artifacts/<task>/<artifact>/<path…>`). Both resolve
 *    inside that Task's own folder under the Switchboard home. Nothing a delta carries is ever written to a runner's
 *    folder (`~/.claude`, `~/.codex`), a repository or the runner's memory: a runner's session file is neither sent
 *    nor taken in.
 */
export const UPLINK_LIMITS = {
  /** The object as it lies in the bucket (compressed). */
  objectBytes: 96 * 1024 * 1024,
  /** Everything it unpacks to. */
  expandedBytes: 256 * 1024 * 1024,
  /** `delta.json` alone (it is parsed in memory). */
  jsonBytes: 96 * 1024 * 1024,
  /** One file in it; the sender leaves a bigger one out (`deltaFileRefusal`). */
  fileBytes: 64 * 1024 * 1024,
  entries: 20_000,
  /** How many deltas of one machine go in per round; the rest wait for the next. */
  perRound: 200,
};
export type UplinkLimits = typeof UPLINK_LIMITS;

/** A Task's or an artifact's id as a folder name. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Whether `v` is an id a row of a delta may carry: the ids are folder names here (a Task's, an artifact's), so nothing else comes in. */
export const isRowId = (v: unknown): v is string => typeof v === "string" && ID.test(v) && v !== "inbox";
const MAX_DEPTH = 12;

/** One segment of a file's path: no separator, no control character, not hidden, not `.`/`..`, not a store's own working names. */
function segmentOk(s: string): boolean {
  return s.length > 0 && Buffer.byteLength(s) <= 255 && !s.startsWith(".") && !s.endsWith(".old") && !/[\x00-\x1f\x7f/\\]/.test(s);
}

/**
 * Where `files/<name>` of a delta goes on this instance, or why it goes nowhere. The one judgement of a file's name:
 * the sender asks it too (`deltaFileRefusal`), so it never packs what would be refused here.
 */
export function placeOf(cfg: Pick<CoreConfig, "attachmentsDir" | "artifactsDir">, name: string): { kind: "attachments" | "artifacts"; task: string; dest: string } | { refusal: string } {
  const no = (why: string) => ({ refusal: `files/${name.slice(0, 200)} ${why}` });
  if (name.includes("\\") || name.startsWith("/") || name.includes("\0")) return no("is not a relative name");
  const parts = name.split("/");
  const [kind, task, ...rest] = parts;
  if (kind !== "attachments" && kind !== "artifacts") return no("is not a place a delta writes to");
  if (!task || !ID.test(task) || task === "inbox") return no("names no Task");
  if (kind === "attachments" ? rest.length !== 1 : rest.length < 2 || rest.length > MAX_DEPTH || !ID.test(rest[0]!)) return no("is not the shape of a Task's file");
  if (!rest.every(segmentOk)) return no("has a part that is not a plain file name");
  const root = resolve(kind === "attachments" ? cfg.attachmentsDir : cfg.artifactsDir, task);
  const dest = resolve(root, ...rest);
  if (!dest.startsWith(root + sep)) return no(`leaves ${root}`);
  return { kind, task, dest };
}

/** Why the sender leaves a file out of a delta (its name or its size would be refused by the instance); null = it goes. */
export function deltaFileRefusal(cfg: Pick<CoreConfig, "attachmentsDir" | "artifactsDir">, name: string, size: number): string | null {
  const at = placeOf(cfg, name);
  if ("refusal" in at) return at.refusal;
  return size > UPLINK_LIMITS.fileBytes ? `files/${name} is ${size} bytes: over the ${UPLINK_LIMITS.fileBytes} a delta carries` : null;
}

export interface Unpacked {
  /** `delta.json`, parsed; nothing in it has been checked. */
  delta: unknown;
  /** The files, each in the stage under a number; `name` is the entry's name without `files/`, already through `accept`. */
  files: Array<{ name: string; path: string; size: number }>;
}

const octal = (b: Buffer) => {
  const s = b.toString("latin1").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(s)) throw new Error("a tar header's size is not a number");
  return s === "" ? 0 : Number.parseInt(s, 8);
};
const text = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");

/**
 * Unpacks a delta (`<name>.tar.zst`, as `writeTarZst` makes it) into `stage`, within `limits`. `accept` judges each
 * file's name before a byte of it is written and throws for one that has no place. Throws for an entry that is not a
 * plain file, for a second `delta.json`, for one that is missing, and for anything over a limit — nothing of the
 * delta is believed then (the caller removes the stage).
 */
export async function unpackDelta(file: string, stage: string, accept: (name: string) => void, limits: UplinkLimits = UPLINK_LIMITS): Promise<Unpacked> {
  const source = createReadStream(file);
  const stream = source.pipe(createZstdDecompress());
  source.on("error", (e) => stream.destroy(e));
  const chunks = stream[Symbol.asyncIterator]();
  let held: Buffer = Buffer.alloc(0);
  let expanded = 0;
  /** The next `n` bytes; fewer only at the end of the stream. */
  const read = async (n: number): Promise<Buffer> => {
    while (held.length < n) {
      const next = await chunks.next();
      if (next.done) break;
      const chunk = next.value as Buffer;
      expanded += chunk.length;
      if (expanded > limits.expandedBytes) throw new Error(`the delta unpacks to more than ${limits.expandedBytes} bytes`);
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
    }
    const out = held.subarray(0, n);
    held = held.subarray(out.length);
    return out;
  };
  const skipPad = async (size: number) => void (await read((512 - (size % 512)) % 512));
  const body = async (size: number, max: number, what: string): Promise<Buffer> => {
    if (size > max) throw new Error(`${what} is ${size} bytes: over the limit of ${max}`);
    const b = await read(size);
    if (b.length !== size) throw new Error(`${what} is cut short`);
    await skipPad(size);
    return Buffer.from(b);
  };
  const files: Unpacked["files"] = [];
  let delta: unknown;
  let seen = false;
  let entries = 0;
  let pax: { path?: string; size?: number } = {};
  try {
    for (;;) {
      const head = await read(512);
      if (head.length === 0 || head.every((x) => x === 0)) break;
      if (head.length !== 512) throw new Error("the delta's tar is cut short");
      if (++entries > limits.entries * 2) throw new Error(`the delta holds more than ${limits.entries} entries`);
      const type = String.fromCharCode(head[156]!);
      const size = octal(head.subarray(124, 136));
      if (type === "x") {
        // a PAX header for the entry after it: a long or non-ASCII name, a size past the header's field
        const records = await body(size, 64 * 1024, "a tar name header");
        pax = {};
        // `<length in bytes> <key>=<value>\n`, the length counting the whole record
        for (let at = 0; at < records.length; ) {
          const space = records.indexOf(0x20, at);
          const len = space < 0 ? Number.NaN : Number(records.subarray(at, space).toString("latin1"));
          if (!Number.isInteger(len) || len <= space - at + 1 || at + len > records.length) throw new Error("a tar name header cannot be read");
          const [key, value] = records.subarray(space + 1, at + len - 1).toString("utf8").split(/=(.*)/s);
          if (key === "path") pax.path = value;
          else if (key === "size") pax.size = Number(value);
          at += len;
        }
        continue;
      }
      if (type !== "0" && type !== "\0") throw new Error(`the delta holds an entry that is not a plain file (type ${JSON.stringify(type)})`);
      const prefix = text(head.subarray(345, 500));
      const name = pax.path ?? (prefix ? `${prefix}/${text(head.subarray(0, 100))}` : text(head.subarray(0, 100)));
      const length = pax.size ?? size;
      pax = {};
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("a tar entry's size cannot be read");
      if (name === "delta.json") {
        if (seen) throw new Error("the delta holds delta.json twice");
        seen = true;
        delta = JSON.parse((await body(length, limits.jsonBytes, "delta.json")).toString("utf8"));
        continue;
      }
      if (!name.startsWith("files/")) throw new Error(`${name.slice(0, 200)} is not a place a delta writes to`);
      if (files.length >= limits.entries) throw new Error(`the delta holds more than ${limits.entries} files`);
      const rel = name.slice("files/".length);
      accept(rel);
      if (length > limits.fileBytes) throw new Error(`files/${rel} is ${length} bytes: over the limit of ${limits.fileBytes}`);
      const path = join(stage, String(files.length));
      const fd = openSync(path, "wx", 0o600);
      try {
        for (let left = length; left > 0; ) {
          const part = await read(Math.min(left, 1 << 20));
          if (part.length === 0) throw new Error(`files/${rel} is cut short`);
          writeSync(fd, part);
          left -= part.length;
        }
      } finally {
        closeSync(fd);
      }
      await skipPad(length);
      files.push({ name: rel, path, size: length });
    }
  } finally {
    stream.destroy();
    source.destroy();
  }
  if (!seen) throw new Error("not a delta: it has no delta.json");
  return { delta, files };
}
