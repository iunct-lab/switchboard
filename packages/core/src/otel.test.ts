import { recordingText, skipRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { decisionsFromOtlp } from "./otel.ts";

const rec = (attrs: Record<string, string | number>) => ({ attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: v } : { stringValue: v } })) });
const body = (...records: unknown[]) => ({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }] }] });

describe("decisionsFromOtlp (#2236)", () => {
  test("a block keeps its category; an allow has none; only the five values come out", () => {
    const out = decisionsFromOtlp(body(
      rec({ "event.name": "tool_decision", decision: "reject", source: "config", classifier_verdict: "block", classifier_category: "Irreversible Local Destruction", permission_mode: "auto", tool_name: "Bash", tool_use_id: "toolu_b", "user.email": "dev@example.com", tool_parameters: "{\"command\":\"rm -rf x\"}" }),
      rec({ "event.name": "tool_decision", decision: "accept", source: "config", classifier_verdict: "allow", classifier_category: "ignored", permission_mode: "auto", tool_name: "Read", tool_use_id: "toolu_a", "event.sequence": 3 }),
    ));
    expect(out).toEqual([
      { t: "classifier.decision", verdict: "block", category: "Irreversible Local Destruction", mode: "auto", tool: "Bash", callId: "toolu_b" },
      { t: "classifier.decision", verdict: "allow", category: null, mode: "auto", tool: "Read", callId: "toolu_a" },
    ]);
  });

  test.skipIf(skipRecordings("packages/core/fixtures/otel-classifier-stop.jsonl"))("decisionsFromOtlp: a recorded block keeps its category (classifier, 2.1.312)", () => {
    const out = recordingText("packages/core/fixtures/otel-classifier-stop.jsonl").split("\n").filter(Boolean).flatMap((l) => decisionsFromOtlp(JSON.parse(l)));
    expect(out.map(({ verdict, category, mode, tool }) => ({ verdict, category, mode, tool }))).toEqual([
      { verdict: "allow", category: null, mode: "auto", tool: "Bash" },
      { verdict: "block", category: "interfere_with_workloads", mode: "auto", tool: "Bash" },
    ]);
    expect(JSON.stringify(out)).not.toContain("example.invalid");
  });

  test.skipIf(skipRecordings("packages/core/fixtures/otel-classifier-ask.jsonl"))("decisionsFromOtlp: a recorded ask answered by the person is no verdict, only the stops before it count (classifier, 2.1.314)", () => {
    const out = recordingText("packages/core/fixtures/otel-classifier-ask.jsonl").split("\n").filter(Boolean).flatMap((l) => decisionsFromOtlp(JSON.parse(l)));
    expect(out.map(({ verdict, category }) => ({ verdict, category }))).toEqual([
      { verdict: "allow", category: null },
      { verdict: "block", category: "interfere_with_workloads" },
      { verdict: "block", category: "interfere_with_workloads" },
    ]);
  });

  test("not the classifier's: no verdict (a rule, the person), no_verdict / unavailable, other events, malformed bodies", () => {
    expect(decisionsFromOtlp(body(
      rec({ "event.name": "tool_decision", decision: "accept", source: "user_temporary", tool_name: "Bash", tool_use_id: "toolu_u" }),
      rec({ "event.name": "tool_decision", classifier_verdict: "no_verdict", tool_name: "Bash" }),
      rec({ "event.name": "tool_decision", classifier_verdict: "unavailable", tool_name: "Bash" }),
      rec({ "event.name": "tool_result", classifier_verdict: "allow", tool_name: "Bash" }),
      { attributes: "x" },
      null,
    ))).toEqual([]);
    for (const b of [null, undefined, "x", 1, {}, { resourceLogs: {} }, { resourceLogs: [{ scopeLogs: [null] }] }]) expect(decisionsFromOtlp(b)).toEqual([]);
  });
});
