import * as backlogRead from "./backlog-read.ts";
import * as guards from "./guards.ts";
import * as lifecycle from "./lifecycle.ts";
import * as logins from "./logins.ts";
import * as settings from "./settings.ts";
import * as http from "./http.ts";
import * as routing from "./routing.ts";
import * as teleport from "./teleport.ts";
import * as mcp from "./mcp.ts";
import * as promotion from "./promotion.ts";
import * as bundle from "./bundle.ts";
import * as cliUpdate from "./cli-update.ts";
import * as lease from "./lease.ts";
import * as evals from "./evals.ts";
import * as start from "./start.ts";
import * as queue from "./queue.ts";
import * as asks from "./asks.ts";
import * as releaseReview from "./release-review.ts";
import * as backlogNext from "./backlog-next.ts";
import * as taskHooks from "./task-hooks.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";

/** A module of functions that take the context first: each export is a function of the context under the same name. */
type Bindable = { [K in keyof ServerContext]?: ServerContext[K] extends (...a: infer A) => infer R ? (sc: ServerContext, ...a: A) => R : never };

/** A module's `setup…` exports fill in the context's values when the daemon starts (startServer calls them in order); they are not put on the context. */
type Setup = `setup${string}`;

/** Put every export of `fns` on the context as `sc.<name>(…)` = `<name>(sc, …)`. An export that is neither a function of the context nor a `setup…` does not type-check. */
function bind<M extends Bindable>(sc: ServerContextInit, fns: M & Record<Exclude<keyof M, keyof ServerContext | Setup>, never>): void {
  for (const [name, f] of Object.entries(fns)) if (!name.startsWith("setup")) (sc as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => (f as (...x: unknown[]) => unknown)(sc, ...a);
}

/** The context's functions, one module per feature (a module is added here; a function only in its module and in ServerContext). */
export function bindFunctions(sc: ServerContextInit): void {
  bind(sc, backlogRead);
  bind(sc, guards);
  bind(sc, lifecycle);
  bind(sc, logins);
  bind(sc, settings);
  bind(sc, http);
  bind(sc, routing);
  bind(sc, teleport);
  bind(sc, mcp);
  bind(sc, promotion);
  bind(sc, bundle);
  bind(sc, cliUpdate);
  bind(sc, lease);
  bind(sc, evals);
  bind(sc, start);
  bind(sc, queue);
  bind(sc, asks);
  bind(sc, releaseReview);
  bind(sc, backlogNext);
  bind(sc, taskHooks);
}
