import { join } from "node:path";
import { type RunnerId, Settings, type PricingTable } from "@switchboard/protocol";
import { SHIPPED_HIDDEN_MODELS } from "../model-catalog.ts";
import { SETTINGS_KEY } from "./helpers.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { loadRoutingTable } from "../routing.ts";

export const settings = (sc: Pick<ServerContext, "db">): Settings => {
  const parsed = Settings.safeParse(sc.db.getSetting(SETTINGS_KEY, {}));
  if (!parsed.success) console.warn(`settings: stored row is malformed (${parsed.error.message}); using defaults`);
  return parsed.success ? parsed.data : Settings.parse({});
};

// The default of every setting, so the settings screen can show each value's default and put it back without a copy
// of its own; `hiddenModels` is what a runner's 載せない list is while none is saved
export const settingsDefaults = (_sc: unknown) => ({ ...Settings.parse({}), hiddenModels: SHIPPED_HIDDEN_MODELS });

export const savedDefaultMode = (sc: Pick<ServerContext, "settings">, runner: RunnerId) => sc.settings().defaultPermissionMode[runner];

export const savedAutoResume = (sc: Pick<ServerContext, "settings">, runner: RunnerId) => sc.settings().autoResume[runner] === true;

export const savedModels = (sc: Pick<ServerContext, "settings">, runner: RunnerId) => sc.settings().models[runner];

export const shipped = (_sc: unknown, root: string, file: string) => join(root, "packages", "core", "config", file);

// The settings screen's price rows over the file's table, read on every use so a PATCH prices the next usage
export const pricingTable = (sc: Pick<ServerContext, "pricing" | "settings">): PricingTable => ({ ...sc.pricing.table, models: { ...sc.pricing.table.models, ...sc.settings().prices } });

export function setupShipped(sc: Pick<ServerContextInit, "liveRoot" | "cfg" | "webDist" | "routing" | "shipped">): void {
  // Rule table: the user's ~/.switchboard/routing.yaml wins over the shipped default. Loaded once per boot.
  // The shipped defaults are read from `liveRoot`: the code root at boot, the `releases/current` version after a reload (SIGHUP).
  sc.liveRoot = sc.cfg.codeRoot;
  sc.webDist = sc.cfg.webDist;
  sc.routing = loadRoutingTable([join(sc.cfg.home, "routing.yaml"), sc.shipped(sc.liveRoot, "routing.yaml")]);
}
