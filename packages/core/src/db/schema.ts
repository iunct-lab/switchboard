/** The tables and indexes of the database (`SCHEMA`), and the temporary ones a connection keeps for itself. */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL,
  scope TEXT NOT NULL, status TEXT NOT NULL, runner_session_id TEXT, model TEXT, routing TEXT, budget_usd REAL, schedule_id TEXT,
  permission_mode TEXT, effort TEXT, subagent_effort TEXT, subagent_model TEXT, origin TEXT NOT NULL DEFAULT 'switchboard', resume_at INTEGER, resume_reason TEXT, resume_window TEXT, resume_since INTEGER, resume_planned_at INTEGER, queued_at INTEGER, queued_prompt TEXT, queued_attachments TEXT, deferred_prompt TEXT, shadow_of TEXT, fork_of TEXT, fork_seq INTEGER, fork_turn TEXT, shadow_stopped INTEGER NOT NULL DEFAULT 0, workspace_reason TEXT,
  outcome TEXT NOT NULL DEFAULT 'unknown', reviewed_at INTEGER, archived_at INTEGER, judged_result TEXT, judged_reason TEXT, judged_by TEXT, judging_at INTEGER, stage_issue INTEGER, stage_action TEXT,
  status_at INTEGER NOT NULL, title_pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, provenance TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, cron TEXT NOT NULL, workspace_id TEXT NOT NULL, runner TEXT NOT NULL, prompt TEXT NOT NULL,
  budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, created_at INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT 'prompt', model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (task_id, seq)
);
-- listStopRecords: the stop.record rows only, so the backlog list does not read every event's json; the WHERE is that query's, word for word
CREATE INDEX IF NOT EXISTS events_stop ON events (task_id) WHERE substr(json, 1, 19) = '{"t":"stop.record",';
-- listEventsByPrefix: the intervention events only; each WHERE is the one listEventsByPrefix builds from EVENT_PREFIX_INDEX, word for word
CREATE INDEX IF NOT EXISTS events_ask ON events (task_id) WHERE substr(json, 1, 22) = '{"t":"permission.ask",';
CREATE INDEX IF NOT EXISTS events_resolved ON events (task_id) WHERE substr(json, 1, 27) = '{"t":"permission.resolved",';
CREATE INDEX IF NOT EXISTS events_user_say ON events (task_id) WHERE substr(json, 1, 34) = '{"t":"message.delta","role":"user"';
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, runner TEXT NOT NULL, model TEXT,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL, billed_usd REAL NOT NULL DEFAULT 0, source TEXT NOT NULL, ts INTEGER NOT NULL, reported_total TEXT,
  billing TEXT NOT NULL DEFAULT 'subscription'
);
CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts);
CREATE INDEX IF NOT EXISTS ledger_task ON ledger (task_id);
CREATE TABLE IF NOT EXISTS routing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, workspace_id TEXT, cwd TEXT NOT NULL,
  suggested TEXT NOT NULL, rule_id TEXT NOT NULL, reason TEXT NOT NULL, chosen TEXT NOT NULL, ts INTEGER NOT NULL,
  suggested_by TEXT NOT NULL DEFAULT 'rule'
);
CREATE INDEX IF NOT EXISTS routing_log_task ON routing_log (task_id);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  path TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, frontmatter TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(path UNINDEXED, title, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS staging (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL, rel TEXT NOT NULL, kind TEXT NOT NULL,
  before_text TEXT, after_text TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, decided_at INTEGER,
  diff_text TEXT NOT NULL DEFAULT '', stat TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS staging_task ON staging (task_id);
CREATE INDEX IF NOT EXISTS staging_status ON staging (status);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
CREATE TABLE IF NOT EXISTS check_runs (
  task_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, json TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history_imports (
  session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '', imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_imports_task ON history_imports (task_id);
CREATE INDEX IF NOT EXISTS tasks_session ON tasks (runner, runner_session_id);
CREATE TABLE IF NOT EXISTS quota (
  runner TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (runner, window)
);
CREATE TABLE IF NOT EXISTS quota_by_account (
  runner TEXT NOT NULL, account TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (runner, account, window)
);
CREATE TABLE IF NOT EXISTS quota_windows (
  runner TEXT NOT NULL, window TEXT NOT NULL, resets_at INTEGER NOT NULL, peak REAL NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  PRIMARY KEY (runner, window, resets_at)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, task_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_task ON attachments (task_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, entry TEXT, mime TEXT NOT NULL,
  size INTEGER NOT NULL, removed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  app_days INTEGER NOT NULL DEFAULT 0, app_last_day TEXT, app_request_task_id TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts (task_id);
CREATE TABLE IF NOT EXISTS perf_samples (
  ts INTEGER NOT NULL, journey TEXT NOT NULL, device TEXT NOT NULL, build TEXT NOT NULL, ms REAL NOT NULL, task_id TEXT, bytes INTEGER, events INTEGER
);
CREATE INDEX IF NOT EXISTS perf_samples_ts ON perf_samples (ts);
CREATE TABLE IF NOT EXISTS backlog_records (
  service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, object_kind TEXT NOT NULL, external_id TEXT NOT NULL,
  remote TEXT, base TEXT, local TEXT, fetched_at INTEGER, fetch_state TEXT NOT NULL,
  PRIMARY KEY (service, host, repository, object_kind, external_id)
);
CREATE TABLE IF NOT EXISTS backlog_repositories (
  service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, cursor TEXT, last_successful_sync INTEGER, retry_at INTEGER,
  PRIMARY KEY (service, host, repository)
);
CREATE TABLE IF NOT EXISTS backlog_operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL,
  issue TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, field TEXT, payload TEXT NOT NULL, base TEXT,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, remote_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, overwritten TEXT
);
CREATE INDEX IF NOT EXISTS backlog_operations_issue ON backlog_operations (service, host, repository, issue);
CREATE INDEX IF NOT EXISTS backlog_operations_target ON backlog_operations (service, host, repository, target_kind, target);
-- listPendingBacklogOperations: the few edits not done, without reading every operation; the WHERE is that query's
CREATE INDEX IF NOT EXISTS backlog_operations_open ON backlog_operations (seq) WHERE status != 'done';
CREATE TABLE IF NOT EXISTS request_evals (
  workspace_id TEXT NOT NULL, issue INTEGER NOT NULL, json TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, issue)
);
CREATE TABLE IF NOT EXISTS task_evals (
  task_id TEXT NOT NULL, source TEXT NOT NULL, by TEXT NOT NULL, rubric TEXT, json TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (task_id, source)
);
-- the copy of a task's diff: one row per task, so a removed worktree can still be shown; kept out of tasks (listTasks reads that often)
CREATE TABLE IF NOT EXISTS task_diffs (task_id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ask_answers (id TEXT PRIMARY KEY, at INTEGER NOT NULL, result TEXT, failure TEXT);
-- merge_grants / merge_scope_stops: replaced by task_grants / task_scope_stops, which name the repository and who gave the
-- grant; they stay, unread, because migrations only add (schema.test.ts) and a rolled-back release reads them
CREATE TABLE IF NOT EXISTS merge_grants (task_id TEXT NOT NULL, kind TEXT NOT NULL, target INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, kind, target));
CREATE TABLE IF NOT EXISTS merge_scope_stops (task_id TEXT NOT NULL, issue INTEGER NOT NULL, pr INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, issue));
-- a sentence that lets a refused merge step through (merge-grants.ts), valid for the task's conversation. One row says for which
-- task, repository (lower case), kind and number, the head the PR had then (head, added by migration 0049: a merge / answer
-- grant answers only for it; '' = not read, answers for none), how the text came in (by: 'owner' = it came the way the
-- screen sends it; 'api' = a call that named no sender and did not look like the screen; 'task:<id>' = the Task that said it
-- sent it — only 'owner' is counted) and what it was read from (source: the screen answer's comment operation id, '' = said to
-- the task directly). An answer gives its grants once: a source that has a row is spent. 'owner' is not a proof of who
-- typed: on loopback a Task can call the same routes the same way (merge-grants.ts)
CREATE TABLE IF NOT EXISTS task_grants (
  task_id TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL, target INTEGER NOT NULL, by TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
  PRIMARY KEY (task_id, repo, kind, target, by, source)
);
CREATE INDEX IF NOT EXISTS task_grants_source ON task_grants (source) WHERE source != '';
-- every head a merge / answer grant was given for (migration 0057): task_grants keeps the newest head only, this keeps each allowed one, for the tables that count who allowed what
CREATE TABLE IF NOT EXISTS task_grant_heads (task_id TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL, target INTEGER NOT NULL, head TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, repo, kind, target, head, by, at));
-- the host CLIs' versions (cli-update-install.ts): one row per decision about a version. outcome: installed / refused /
-- waiting / untested / rolled-back; by: auto (the daemon decided) / person (a person asked); from_version is the version
-- the link pointed at before, sha256 the checksum the file was checked against (NULL = none was published)
CREATE TABLE IF NOT EXISTS cli_updates (id INTEGER PRIMARY KEY, runner TEXT NOT NULL, at INTEGER NOT NULL, from_version TEXT, to_version TEXT NOT NULL, outcome TEXT NOT NULL, sha256 TEXT, reason TEXT NOT NULL, by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS cli_updates_runner ON cli_updates (runner, id);
-- not read any more; kept because a rolled-back release reads it (like merge_scope_stops)
CREATE TABLE IF NOT EXISTS task_scope_stops (task_id TEXT NOT NULL, repo TEXT NOT NULL, issue INTEGER NOT NULL, pr INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, repo, issue));
-- every change asked of a workspace's settings kept here (workspaces.config), whoever asked: what the settings were
-- (before) and what was asked (after; NULL = none), the top-level keys that differ (keys, a JSON array), how the request
-- came in (source: 'person' = the login cookie with a fresh passkey check, 'screen' = it looked like the web page,
-- 'call' = any other call, a Task's included) and its state: 'pending' = asked, not in force; 'confirmed' = in force
-- from decided_at (workspaces.config was set to after in the same transaction); 'rejected'; 'superseded' = a later
-- request replaced it while it was pending. workspaces.config only ever holds a confirmed value (workspace-config.ts)
CREATE TABLE IF NOT EXISTS workspace_config_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL, before TEXT, after TEXT,
  keys TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, decided_at INTEGER, decided_by TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS workspace_config_changes_state ON workspace_config_changes (state, workspace_id);
-- the local passkeys were reverted; the table stays empty and unused because migrations only add (schema.test.ts, releases-and-rescue.md)
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, rp_id TEXT NOT NULL, public_key TEXT NOT NULL, algorithm INTEGER NOT NULL, counter INTEGER NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
-- one row per daemon start (ops-stops.ts): the stopping daemon writes clean_exit / ended_at, the next start end_reason
CREATE TABLE IF NOT EXISTS daemon_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, end_detail TEXT, clean_exit TEXT,
  version TEXT, boot_id TEXT, interrupted_task_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS daemon_runs_ended ON daemon_runs (ended_at);
-- the host's load once a minute (ops-load.ts): the unit's cgroup, and task × owner × kind of its processes. 7 days
CREATE TABLE IF NOT EXISTS ops_load (
  ts INTEGER PRIMARY KEY, mem_current INTEGER NOT NULL, mem_max INTEGER, swap_current INTEGER NOT NULL, events_max INTEGER NOT NULL,
  cpu_pct REAL, pressure_some REAL, pressure_full REAL, docker_mem INTEGER, top TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_load_groups (
  ts INTEGER NOT NULL, task_id TEXT, owner TEXT NOT NULL, kind TEXT NOT NULL, rss INTEGER NOT NULL, cpu_ms INTEGER NOT NULL, procs INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_load_groups_ts ON ops_load_groups (ts);
-- one row per API request: the route as guardAll keys it (/api/tasks/:id), until the handler's Response. 7 days
CREATE TABLE IF NOT EXISTS api_requests (
  ts INTEGER NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, ms REAL NOT NULL, bytes INTEGER
);
CREATE INDEX IF NOT EXISTS api_requests_ts ON api_requests (ts);
-- the schedules log (scheduler.note): one row per line, schedule_id when it belongs to one schedule. 90 days
CREATE TABLE IF NOT EXISTS schedule_log (
  ts INTEGER NOT NULL, schedule_id TEXT, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_log_ts ON schedule_log (ts);
-- a job a Task asked the daemon to run as the daemon's child (jobs.ts): local CI or a review. pid = the wrapper shell.
-- repo = owner/name in lower case (the app's own change: local:<workspaceId>; '' = not read), head = the checkout's head a review
-- read (null = none / a job from before), base = what the result was measured against, as_reason = why a review is not the plain
-- main review, kinds = the kinds of a recheck (comma-separated), result = JSON of what the end recorded of the output
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT NOT NULL, pr INTEGER NOT NULL, runner TEXT, cwd TEXT NOT NULL,
  pid INTEGER, boot_id TEXT, status TEXT NOT NULL, exit_code INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT,
  repo TEXT NOT NULL DEFAULT '', head TEXT, base TEXT, as_reason TEXT, kinds TEXT NOT NULL DEFAULT '', result TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ended ON jobs (ended_at);
`;

/**
 * Notes which rows of backlog_records were written on this connection, whichever statement wrote them: what
 * listBacklogRecords reads again. TEMP: nothing is stored. Another connection's write is not seen: the daemon's is the only one that
 * writes this table, and PRAGMA data_version will not do — it moves with every commit to the file, Litestream's included.
 */
const noteBacklogRecord = (row: "NEW" | "OLD") => `INSERT INTO backlog_records_changed (repo, object_kind, external_id) VALUES (${row}.service || '/' || ${row}.host || '/' || ${row}.repository, ${row}.object_kind, ${row}.external_id);`;
export const BACKLOG_RECORDS_CHANGED = `
CREATE TEMP TABLE backlog_records_changed (seq INTEGER PRIMARY KEY, repo TEXT NOT NULL, object_kind TEXT NOT NULL, external_id TEXT NOT NULL);
CREATE INDEX temp.backlog_records_changed_repo ON backlog_records_changed (repo);
CREATE TEMP TRIGGER backlog_records_inserted AFTER INSERT ON main.backlog_records BEGIN ${noteBacklogRecord("NEW")} END;
CREATE TEMP TRIGGER backlog_records_updated AFTER UPDATE ON main.backlog_records BEGIN ${noteBacklogRecord("OLD")} ${noteBacklogRecord("NEW")} END;
CREATE TEMP TRIGGER backlog_records_deleted AFTER DELETE ON main.backlog_records BEGIN ${noteBacklogRecord("OLD")} END;
`;
