import type { Database } from "bun:sqlite";
import type { RunnerId } from "@switchboard/protocol";
import { billingFromRow } from "../../pricing.ts";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const lcols = columns("ledger");
  // A row keeps where its bill goes (LedgerBilling). The rows from before have no login to ask, so each gets the kind its
  // own figures say (`billingFromRow`): charged when billed_usd is above 0; a row that cost nothing follows its runner's
  // charged rows (a pay-as-you-go runner's free call is still pay-as-you-go). No figure of a row changes.
  if (!lcols.has("billing")) {
    db.transaction(() => {
      db.exec("ALTER TABLE ledger ADD COLUMN billing TEXT NOT NULL DEFAULT 'subscription'");
      const groups = db.query("SELECT runner, model, billed_usd > 0 AS charged, cost_usd > 0 AS priced FROM ledger GROUP BY runner, model, charged, priced").all() as Array<{ runner: RunnerId; model: string | null; charged: number; priced: number }>;
      const chargedRunners = new Set(groups.filter((g) => g.charged === 1 && billingFromRow(g.runner, g.model, true) !== "bedrock").map((g) => g.runner));
      const set = db.query("UPDATE ledger SET billing = ?1 WHERE runner = ?2 AND model IS ?3 AND (billed_usd > 0) = ?4 AND (cost_usd > 0) = ?5");
      for (const g of groups) set.run(billingFromRow(g.runner, g.model, g.charged === 1 || (g.priced === 0 && chargedRunners.has(g.runner))), g.runner, g.model, g.charged, g.priced);
    })();
  }
}

export const migration: Migration = { number: 30, name: "ledger-billing", run };
