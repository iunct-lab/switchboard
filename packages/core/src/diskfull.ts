import { statfsSync } from "node:fs";
import { READ_TOOLS } from "./ratelimit.ts";

/** How a full disk reads (#2234): Claude Code's Bash refusal (2.1.305), the OS's error, Node's code. A fake's result pins these; a new wording is added when it shows. */
export const DISK_FULL_TEXT = /disk is full|no space left on device|ENOSPC/i;
/** A task stopped by a full disk goes on once this much is free again. */
export const DISK_FREE_MIN_BYTES = 1024 ** 3;
/** How often a task waiting for space looks at the disk. */
export const DISK_CHECK_MS = 5 * 60_000;

/** The words that say the disk is full, if any: only those, a stop's evidence never carries a command's output. */
export function diskFullText(text: string | undefined): string | undefined {
  return text ? DISK_FULL_TEXT.exec(text)?.[0] : undefined;
}

/** The disk-full words a command's result carries; undefined for a read tool (its result is a quote), or none. */
export function diskFullHit(tool: string, summary: string): string | undefined {
  return READ_TOOLS.has(tool) ? undefined : diskFullText(summary);
}

/** Bytes an unprivileged process can still write on the filesystem of `path`. */
export function diskFreeBytes(path: string): number {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}
