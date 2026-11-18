/** The connection: opening the file (a new one from the copy of an empty, migrated database), the settings rows, and the base of the `Db` class. */

import { CustomRunner } from "@switchboard/protocol";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, rmSync, writeSync } from "node:fs";
import type { RunnerId } from "@switchboard/protocol";
import { migrate } from "./migrate.ts";
import { SCHEMA, BACKLOG_RECORDS_CHANGED } from "./schema.ts";
import { safeJson } from "./util.ts";

/** The `settings` row of the ADK servers added in Settings (see Db.getCustomRunners). */
export const CUSTOM_RUNNERS_KEY = "customRunners";

/** Wait out the write lock Litestream's checkpoint takes for a moment, instead of failing with SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

let emptyBytes: Uint8Array | null = null;

/** The file of a database that got `SCHEMA` and `migrate` and holds no rows: written as a new database file, it skips running both again. */
function emptyDatabase(): Uint8Array {
  if (emptyBytes === null) {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec(SCHEMA);
      migrate(db);
      emptyBytes = db.serialize();
    } finally {
      db.close();
    }
  }
  return emptyBytes;
}

/**
 * Write `bytes()` as the file at `path` when there is none. True when it was written.
 * The bytes go to a file of its own first and are synced; only then the name appears (`link`), so no process sees a half-written
 * file, and a stop midway leaves no file at `path`. A file another process made first is not overwritten (`EEXIST`).
 * The mode is SQLite's own default for a new file.
 */
function createdWith(path: string, bytes: () => Uint8Array): boolean {
  if (existsSync(path)) return false;
  const part = `${path}.new-${process.pid}-${crypto.randomUUID()}`;
  try {
    const fd = openSync(part, "wx", 0o644);
    try {
      const data = bytes();
      for (let at = 0; at < data.length; ) at += writeSync(fd, data, at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(part, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(part, { force: true });
  }
}

/** The settings key of the account last named for a runner on this machine (`Db.noteAccount`). */
export const accountKey = (runner: RunnerId) => `runner.account.${runner}`;

/** The base of `Db` (db.ts): the connection and the settings rows. The query files extend it one after another, and `Db` is the last of them. */
export class DbCore {
  readonly sqlite: Database;
  /**
   * The name of the account a runner is logged in to on this machine, as its adapter last named it on a usage-limit
   * report (`noteAccount`; "" = none named yet, or a runner without accounts). A hash the adapter makes from
   * what the runner reports about its login (a pseudonym, not an anonymous value: `docs/design/ledger.md`); this code
   * reads no file of the runner's.
   */
  readonly accountOf: (runner: RunnerId) => string;

  /** `busyTimeoutMs`: a batch beside the daemon (the host's archive) waits longer than the daemon's own few seconds. */
  constructor(path: string, opts: { busyTimeoutMs?: number; /** which account a runner is logged in to here (tests name their own) */ accountOf?: (runner: RunnerId) => string } = {}) {
    this.accountOf = opts.accountOf ?? ((runner) => this.getSetting<string>(accountKey(runner), ""));
    // A new file starts from the copy of an empty, migrated database (the same `SCHEMA` and `migrate`, built once per process)
    const fresh = path !== ":memory:" && createdWith(path, emptyDatabase);
    this.sqlite = new Database(path, { create: true });
    this.sqlite.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
    if (!fresh) {
      // Only a database with no tables yet takes this; an older file is switched once below.
      this.sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL");
      // The usage limits were kept per runner (`quota`); they are per runner and account now. A database from before
      // has its rows moved once, to the account named for each runner here (none yet on the first open: they wait under
      // the empty name, and `noteAccount` hands them to the first account named). `quota` stays for a rolled-back
      // release to read; nothing reads or writes it any more. Whether the move ran is its own record, written in the
      // transaction that moves the rows: a start that stopped after the table was made does not leave them behind.
      this.sqlite.exec(SCHEMA);
      migrate(this.sqlite);
      if (!this.sqlite.query("SELECT 1 FROM settings WHERE key = 'quota.byAccountMoved'").get()) {
        this.sqlite.transaction(() => {
          const put = this.sqlite.query("INSERT OR IGNORE INTO quota_by_account (runner, account, window, utilization, resets_at, ts) VALUES (?, ?, ?, ?, ?, ?)");
          for (const r of this.sqlite.query("SELECT runner, window, utilization, resets_at, ts FROM quota").all() as Array<{ runner: RunnerId; window: string; utilization: number; resets_at: number; ts: number }>)
            put.run(r.runner, this.accountOf(r.runner), r.window, r.utilization, r.resets_at, r.ts);
          this.sqlite.exec("INSERT OR IGNORE INTO settings (key, json) VALUES ('quota.byAccountMoved', 'true')");
        })();
      }
    }
    // the events archive frees pages with `incremental_vacuum`, which only a file in INCREMENTAL mode gives back.
    // The mode of an existing file changes only with a VACUUM; once, before the daemon answers.
    if ((this.sqlite.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum !== 2) this.sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM");
    this.sqlite.exec(BACKLOG_RECORDS_CHANGED);
  }

  close() {
    this.sqlite.close();
  }

  /** A consistent copy of the database at `path` (VACUUM INTO reads through the WAL), as sb-rescue's snapshotDb does. */
  snapshotTo(path: string) {
    this.sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /* ---------- settings: small JSON documents the UI can change ---------- */

  getSetting<T>(key: string, fallback: T): T {
    const r = this.sqlite.query("SELECT json FROM settings WHERE key = ?").get(key) as { json: string } | null;
    return r ? safeJson<T>(r.json, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.sqlite.query("INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(key, JSON.stringify(value));
  }

  /**
   * The ADK servers added in Settings (docs/design/custom-adapter.md), under their own key and not in `Settings`: an
   * older daemon that reads `Settings` and writes it back drops the fields it does not know, but leaves this row alone.
   * A row that does not parse reads as no servers; one entry that does not parse is left out.
   */
  getCustomRunners(): CustomRunner[] {
    const raw = this.getSetting<unknown>(CUSTOM_RUNNERS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
      // a row saved before `port` existed is an ADK server
      const r = CustomRunner.safeParse(typeof x === "object" && x !== null && !("port" in x) ? { port: "adk", ...x } : x);
      return r.success ? [r.data] : [];
    });
  }

  setCustomRunners(list: CustomRunner[]) {
    this.setSetting(CUSTOM_RUNNERS_KEY, list);
  }
}
