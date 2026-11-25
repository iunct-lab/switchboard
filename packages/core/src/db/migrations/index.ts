import type { Migration } from "../migration.ts";
import { migration as m0001 } from "./0001-task-columns.ts";
import { migration as m0002 } from "./0002-backlog-operations-overwritten.ts";
import { migration as m0003 } from "./0003-status-conflicts-sent-again.ts";
import { migration as m0004 } from "./0004-thinking-runs-collapsed.ts";
import { migration as m0005 } from "./0005-background-status.ts";
import { migration as m0006 } from "./0006-outbound-kept-on.ts";
import { migration as m0007 } from "./0007-delegated-note-tail.ts";
import { migration as m0008 } from "./0008-eval-extra-split.ts";
import { migration as m0009 } from "./0009-task-outcome-columns.ts";
import { migration as m0010 } from "./0010-task-reviewed-at.ts";
import { migration as m0011 } from "./0011-task-archived-at.ts";
import { migration as m0012 } from "./0012-task-stage-columns.ts";
import { migration as m0013 } from "./0013-task-judged-columns.ts";
import { migration as m0014 } from "./0014-outcome-done-renamed-finished.ts";
import { migration as m0015 } from "./0015-outcome-kept-by-status.ts";
import { migration as m0016 } from "./0016-task-title-pending.ts";
import { migration as m0017 } from "./0017-task-provenance.ts";
import { migration as m0018 } from "./0018-task-events-archive-columns.ts";
import { migration as m0019 } from "./0019-task-status-at.ts";
import { migration as m0020 } from "./0020-workspace-columns.ts";
import { migration as m0021 } from "./0021-workspace-issue-artifacts.ts";
import { migration as m0022 } from "./0022-workspace-sweep.ts";
import { migration as m0023 } from "./0023-workspace-allocation.ts";
import { migration as m0024 } from "./0024-task-machine.ts";
import { migration as m0025 } from "./0025-routing-log-suggested-by.ts";
import { migration as m0026 } from "./0026-task-shadow-of-unique.ts";
import { migration as m0027 } from "./0027-uplink-src-ids.ts";
import { migration as m0028 } from "./0028-ledger-billed-columns.ts";
import { migration as m0029 } from "./0029-ledger-reported-total.ts";
import { migration as m0030 } from "./0030-ledger-billing.ts";
import { migration as m0031 } from "./0031-schedule-action.ts";
import { migration as m0032 } from "./0032-settings-auto-start.ts";
import { migration as m0033 } from "./0033-answer-policy-use-counts.ts";
import { migration as m0034 } from "./0034-ui-layers-schedule-prompt.ts";
import { migration as m0035 } from "./0035-schedule-samples-record.ts";
import { migration as m0036 } from "./0036-schedule-model-effort-result.ts";
import { migration as m0037 } from "./0037-perf-sample-columns.ts";
import { migration as m0038 } from "./0038-backlog-queue-last-note-at.ts";
import { migration as m0039 } from "./0039-artifact-app-columns.ts";
import { migration as m0040 } from "./0040-staging-diff-columns.ts";
import { migration as m0041 } from "./0041-backlog-operations-failed-sent-again.ts";
import { migration as m0042 } from "./0042-local-change-fields.ts";
import { migration as m0043 } from "./0043-pull-request-files-read-again.ts";
import { migration as m0044 } from "./0044-pull-request-closes.ts";
import { migration as m0045 } from "./0045-session-start-effort.ts";
import { migration as m0046 } from "./0046-backlog-close-fields.ts";
import { migration as m0047 } from "./0047-outcome-from-stop-records.ts";
import { migration as m0048 } from "./0048-task-grants-by-repository.ts";
import { migration as m0049 } from "./0049-task-grants-head.ts";
import { migration as m0050 } from "./0050-cli-updates.ts";
import { migration as m0051 } from "./0051-comment-written-at.ts";
import { migration as m0052 } from "./0052-queued-attachments.ts";
import { migration as m0053 } from "./0053-queued-resume.ts";
import { migration as m0054 } from "./0054-stage-auto.ts";
import { migration as m0055 } from "./0055-stage-auto-history.ts";
import { migration as m0056 } from "./0056-job-facts.ts";
import { migration as m0057 } from "./0057-task-grant-heads.ts";
import { migration as m0058 } from "./0058-backlog-queue-stall.ts";
import { migration as m0059 } from "./0059-job-model.ts";
import { migration as m0060 } from "./0060-promotion-decisions.ts";
import { migration as m0061 } from "./0061-operation-task.ts";

/**
 * Every migration, in the order `migrate` runs them: the order they were written in. A new one is a new file with the next
 * number, added at the end of this list (db.test.ts "migration numbers" fails on a number used twice, a file not listed
 * here, and a list out of order).
 */
export const MIGRATIONS: readonly Migration[] = [
  m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012,
  m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020, m0021, m0022, m0023, m0024,
  m0025, m0026, m0027, m0028, m0029, m0030, m0031, m0032, m0033, m0034, m0035, m0036,
  m0037, m0038, m0039, m0040, m0041, m0042, m0043, m0044, m0045, m0046, m0047, m0048,
  m0049, m0050, m0051, m0052, m0053, m0054, m0055, m0056, m0057, m0058, m0059,
  m0060, m0061,
];
