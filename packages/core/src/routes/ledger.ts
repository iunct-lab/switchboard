import { LedgerBilling } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";
import { clampDays } from "./shared.ts";

/** The `billing` of a ledger request: undefined when absent (every kind together), "invalid" for anything that is not a billing kind. */
export function ledgerBillingOf(req: Request): LedgerBilling | undefined | "invalid" {
  const raw = new URL(req.url).searchParams.get("billing");
  if (raw === null) return undefined;
  const parsed = LedgerBilling.safeParse(raw);
  return parsed.success ? parsed.data : "invalid";
}

/** Knowledge errors: ENOENT-class → 404, containment/validation → 400, and never leak absolute paths. */
export const BILLING_INVALID = `billing must be one of ${LedgerBilling.options.join(", ")}`;

/** The routes under /api/ledger. */
export function ledgerRoutes(sc: Pick<ServerContext, "json" | "db" | "githubBudget" | "metaWorkspace" | "cfg" | "bad" | "pricingTable" | "settings" | "pricing" | "liveRoot">): Routes {
  return {
    "/api/ledger/summary": async () => sc.json({ ...sc.db.ledgerSummary(), github: await sc.githubBudget.get(sc.metaWorkspace()?.path ?? sc.cfg.codeRoot) }),
    // `billing` (optional, on the three below): only the rows of that billing kind; absent = all of them together
    "/api/ledger/daily": (req) => {
      const billing = ledgerBillingOf(req);
      return billing === "invalid" ? sc.bad(BILLING_INVALID) : sc.json(sc.db.ledgerDaily(clampDays(new URL(req.url).searchParams.get("days")), undefined, billing));
    },
    "/api/ledger/tasks": (req) => {
      const billing = ledgerBillingOf(req);
      return billing === "invalid" ? sc.bad(BILLING_INVALID) : sc.json(sc.db.ledgerTasks(clampDays(new URL(req.url).searchParams.get("days")), undefined, undefined, billing));
    },
    // Ledger: the period per runner × model. `days` is an integer 1..90 (absent = 7); anything else is 400, not rounded.
    "/api/ledger/models": (req) => {
      const raw = new URL(req.url).searchParams.get("days");
      const days = raw === null ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) return sc.bad("days must be an integer 1..90");
      const billing = ledgerBillingOf(req);
      return billing === "invalid" ? sc.bad(BILLING_INVALID) : sc.json(sc.db.ledgerModels(days, undefined, billing));
    },
    "/api/ledger/pricing": () => sc.json({ ...sc.pricingTable(), fromSettings: Object.keys(sc.settings().prices), source: sc.pricing.source.replace(sc.cfg.home, "~/.switchboard").replace(sc.liveRoot, "<repo>"), problems: sc.pricing.problems }),
  };
}
