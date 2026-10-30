import type { AgentEvent } from "@switchboard/protocol";

export type ClassifierDecision = Extract<AgentEvent, { t: "classifier.decision" }>;

/** An OTLP attribute's value as a string: `stringValue`, or the other scalar kinds as text; null when absent. */
function attr(attrs: unknown, key: string): string | null {
  if (!Array.isArray(attrs)) return null;
  const v = (attrs.find((a) => a && typeof a === "object" && (a as { key?: unknown }).key === key) as { value?: Record<string, unknown> } | undefined)?.value;
  if (!v || typeof v !== "object") return null;
  for (const k of ["stringValue", "intValue", "doubleValue", "boolValue"]) if (v[k] !== undefined && v[k] !== null) return String(v[k]);
  return null;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The classifier's decisions in an OTLP/HTTP JSON logs request (#2236, docs/design/claude-otel.md): the `tool_decision`
 * records whose `classifier_verdict` is allow or block. Everything else in the body — other events, the account
 * attributes, the tool's parameters, `no_verdict` / `unavailable` — is not returned, so nothing of it is kept.
 */
export function decisionsFromOtlp(body: unknown): ClassifierDecision[] {
  const out: ClassifierDecision[] = [];
  for (const rl of list((body as { resourceLogs?: unknown } | null)?.resourceLogs)) {
    for (const sl of list((rl as { scopeLogs?: unknown } | null)?.scopeLogs)) {
      for (const rec of list((sl as { logRecords?: unknown } | null)?.logRecords)) {
        const a = (rec as { attributes?: unknown } | null)?.attributes;
        if (attr(a, "event.name") !== "tool_decision") continue;
        const verdict = attr(a, "classifier_verdict");
        if (verdict !== "allow" && verdict !== "block") continue;
        out.push({ t: "classifier.decision", verdict, category: verdict === "block" ? attr(a, "classifier_category") : null, mode: attr(a, "permission_mode"), tool: attr(a, "tool_name") ?? "tool", callId: attr(a, "tool_use_id") });
      }
    }
  }
  return out;
}
