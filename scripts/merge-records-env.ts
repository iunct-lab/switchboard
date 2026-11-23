/** The variables `mergeRecords` (ops-kit/src/merge-records.ts) reads, filled from where the app puts its address and key when none is given, so a terminal outside the app's Task reaches it too. */
import { DEFAULT_PORT, tokenPathOf } from "../packages/core/src/config.ts";

type Env = Record<string, string | undefined>;

export function mergeRecordsEnv(env: Env): Env {
  // any variable the Task or the caller gave stays as it is: `mergeRecords` takes an address and a key only as a pair from one source
  if (env.MERGE_RECORDS_URL || env.MERGE_RECORDS_TOKEN_FILE || env.BACKLOG_URL || env.BACKLOG_TOKEN_FILE) return env;
  return { ...env, MERGE_RECORDS_URL: `http://127.0.0.1:${env.SWITCHBOARD_PORT || DEFAULT_PORT}`, MERGE_RECORDS_TOKEN_FILE: tokenPathOf(env) };
}
