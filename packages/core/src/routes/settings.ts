import { AutoStartKind, type AutoStartChoice, type RunnerId, Settings, SettingsPatch } from "@switchboard/protocol";
import { claudeCatalog, codexCatalog, hostReaders, modelCandidates, SHIPPED_HIDDEN_MODELS, type CatalogRunner } from "../model-catalog.ts";
import { parseCron } from "../cron.ts";
import { subagentModelAlias } from "../backlog-prompt.ts";
import type { Routes, ServerContext } from "../server/context.ts";
import { SETTINGS_KEY } from "../server/helpers.ts";

/** A runner the parallel-run default and a kind's parallel run may name: detected, and not a custom server. */
function shadowChoosable(sc: Pick<ServerContext, "adapterMap">, runner: string): boolean {
  return sc.adapterMap.has(runner as RunnerId) && !runner.startsWith("custom:");
}

/** The 400 text for a runner shadowChoosable refuses: "not installed" only when it was not detected. */
function shadowRefusal(sc: Pick<ServerContext, "adapterMap">, runner: string): string {
  return sc.adapterMap.has(runner as RunnerId) ? `runner "${runner}" cannot be a parallel run default` : `runner "${runner}" is not installed`;
}

/** The routes under /api/settings. */
export function settingsRoutes(sc: Pick<ServerContext, "opts" | "adapterMap" | "savedModels" | "settings" | "json" | "runnerInfo" | "settingsDefaults" | "strong" | "bad" | "tasks" | "db" | "logOp" | "armPromotionCheck" | "armCliUpdateCheck">): Routes {
  return {
    // 「CLI の表を読む」: read only when asked (the claude executable is about 240 MB), never at boot or on a timer
    "/api/settings/model-candidates": {
      GET: async () => {
        const read = sc.opts.modelCatalog ?? ((r: CatalogRunner) => hostReaders()[r]());
        const parsers: [CatalogRunner, typeof claudeCatalog][] = [["claude", claudeCatalog], ["codex", codexCatalog]];
        const out = await Promise.all(
          parsers.map(async ([runner, parse]) => {
            try {
              // a runner without its adapter cannot take a 足す or 載せない (the PATCH refuses it), so its table is not offered
              if (!sc.adapterMap.has(runner)) return { runner, error: "ランナーが検出されていない" };
              const text = await read(runner);
              if (text === null) return { runner, error: "CLI が PATH に無い" };
              const catalog = parse(text);
              if (!catalog.length) return { runner, error: "モデル表が 0 件（CLI の形式が変わった）" };
              const listed = (sc.savedModels(runner) ?? sc.adapterMap.get(runner)?.models ?? []).map((m) => m.value);
              return { runner, candidates: modelCandidates(catalog, listed, sc.settings().hiddenModels[runner] ?? SHIPPED_HIDDEN_MODELS[runner]) };
            } catch (e) {
              return { runner, error: String((e as Error).message ?? e) };
            }
          }),
        );
        return sc.json(out);
      },
    },
    "/api/settings": {
      GET: () => sc.json({ ...sc.settings(), runners: sc.runnerInfo(), defaults: sc.settingsDefaults() }),
      PATCH: sc.strong(async (req, srv) => {
        const parsed = SettingsPatch.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const next = sc.settings();
        // A key sent as null goes back whole to its default: the one way every card's 既定に戻す works. What is left
        // (`data`) holds no null key, so each key's own rules below read only what was sent as a value.
        const fresh = Settings.parse({});
        const data = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== null)) as { [K in keyof SettingsPatch]: NonNullable<SettingsPatch[K]> };
        for (const key of Object.keys(parsed.data) as (keyof SettingsPatch)[]) if (parsed.data[key] === null) Object.assign(next, { [key]: fresh[key] });
        // A runner a row may be set to: one installed here, or the one that row ships with. A new instance already holds
        // the shipped value whatever is installed (and a whole key sent as null goes back to it), so putting one row
        // back to it is not a new choice — and a card's 既定に戻す must not fail as a whole on a runner this machine lacks.
        const shipped = fresh;
        const choosable = (runner: RunnerId, shippedRunner: RunnerId) => sc.adapterMap.has(runner) || runner === shippedRunner;
        for (const [runner, mode] of Object.entries(data.defaultPermissionMode ?? {})) {
          if (mode === null) {
            delete next.defaultPermissionMode[runner];
            continue;
          }
          const adapter = sc.adapterMap.get(runner as RunnerId);
          if (!adapter) return sc.bad(`runner "${runner}" is not installed`);
          const why = sc.tasks.checkPermissionMode(runner as RunnerId, mode);
          if (why) return sc.bad(why);
          if (adapter.permissionModes?.find((m) => m.value === mode)?.danger) return sc.bad(`"${mode}" skips approvals and cannot be a default; choose it per task`);
          next.defaultPermissionMode[runner] = mode;
        }
        for (const [runner, effort] of Object.entries(data.subagentEffort ?? {})) {
          if (effort === null) {
            delete next.subagentEffort[runner];
            continue;
          }
          if (runner !== "claude" || !sc.adapterMap.has(runner)) return sc.bad(`runner "${runner}" has no subagent effort (only claude)`);
          const why = sc.tasks.checkEffort(runner as RunnerId, effort);
          if (why) return sc.bad(why);
          next.subagentEffort[runner] = effort;
        }
        for (const [runner, model] of Object.entries(data.subagentModel ?? {})) {
          if (model === null) {
            delete next.subagentModel[runner];
            continue;
          }
          if (runner !== "claude" || !sc.adapterMap.has(runner)) return sc.bad(`runner "${runner}" has no subagent model (only claude)`);
          if (model.trim() === "") return sc.bad("model must not be empty (null removes it)");
          next.subagentModel[runner] = model.trim();
        }
        for (const [runner, model] of Object.entries(data.defaultModel ?? {})) {
          if (model === null) {
            delete next.defaultModel[runner];
            continue;
          }
          const adapter = sc.adapterMap.get(runner as RunnerId);
          if (!adapter) return sc.bad(`runner "${runner}" is not installed`);
          if (!adapter.models) return sc.bad(`runner "${runner}" has no model to choose`);
          if (model.trim() === "") return sc.bad("model must not be empty (null removes it)");
          next.defaultModel[runner] = model.trim();
        }
        for (const [runner, effort] of Object.entries(data.defaultEffort ?? {})) {
          if (effort === null) {
            delete next.defaultEffort[runner];
            continue;
          }
          const why = sc.tasks.checkEffort(runner as RunnerId, effort); // also refuses a runner that is not installed
          if (why) return sc.bad(why);
          next.defaultEffort[runner] = effort;
        }
        for (const [runner, on] of Object.entries(data.autoResume ?? {})) {
          if (on === null || on === false) {
            delete next.autoResume[runner];
            continue;
          }
          if (!sc.adapterMap.has(runner as RunnerId)) return sc.bad(`runner "${runner}" is not installed`);
          next.autoResume[runner] = true;
        }
        // Amazon Bedrock: only a runner whose adapter has `bedrockModel` can be switched; null goes back to its own login
        for (const [runner, v] of Object.entries(data.bedrock ?? {})) {
          if (v === null) {
            delete next.bedrock[runner];
            continue;
          }
          if (!sc.adapterMap.get(runner as RunnerId)?.bedrockModel) return sc.bad(`runner "${runner}" cannot run on Amazon Bedrock`);
          next.bedrock[runner] = { region: v.region };
        }
        // The model choices: the whole list per runner, null = back to the bundled list. A runner that has no
        // list of its own (dak: its model is set on its side) or is not detected cannot have one. The id is not checked
        // against the CLI (`--model` takes any id); a blank or repeated one, or an empty list, is refused.
        for (const [runner, list] of Object.entries(data.models ?? {})) {
          if (list === null) {
            delete next.models[runner];
            continue;
          }
          const adapter = sc.adapterMap.get(runner as RunnerId);
          if (!adapter) return sc.bad(`runner "${runner}" is not installed`);
          if (!adapter.models?.length) return sc.bad(`runner "${runner}" has no model list`);
          // an empty list would read as a runner with no list (the screens show it like dak); null is the way back
          if (!list.length) return sc.bad("model list is empty; send null to go back to the bundled list");
          const rows = list.map((m) => ({ value: m.value.trim(), label: m.label.trim() || m.value.trim() }));
          if (rows.some((m) => !m.value)) return sc.bad("model id is empty");
          const dup = rows.find((m, i) => rows.findIndex((o) => o.value === m.value) !== i);
          if (dup) return sc.bad(`model "${dup.value}" is listed twice`);
          next.models[runner] = rows;
        }
        // The 載せない list: the whole list per runner, null = back to the bundled list's. Only a runner with a
        // model list of its own; blank ids are dropped, an empty list hides nothing.
        for (const [runner, ids] of Object.entries(data.hiddenModels ?? {})) {
          if (ids === null) {
            delete next.hiddenModels[runner];
            continue;
          }
          const adapter = sc.adapterMap.get(runner as RunnerId);
          if (!adapter) return sc.bad(`runner "${runner}" is not installed`);
          if (!adapter.models?.length) return sc.bad(`runner "${runner}" has no model list`);
          next.hiddenModels[runner] = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
        }
        // LLM routing suggestions: a partial patch; the runner must be detected because the suggestion is
        // produced by that runner's own adapter. Enabling it spends that subscription's quota per task creation.
        if (data.routing?.llm) {
          const patch = data.routing.llm;
          if (patch.runner !== undefined && !choosable(patch.runner, shipped.routing.llm.runner)) return sc.bad(`runner "${patch.runner}" is not installed`);
          // a model and an effort belong to one runner: a runner change without them goes back to the runner's default
          const llmRunnerChanged = patch.runner !== undefined && patch.runner !== next.routing.llm.runner;
          next.routing = { ...next.routing, llm: { ...next.routing.llm, ...(llmRunnerChanged ? { model: "", effort: "" } : {}), ...patch } };
          const llmWhy = patch.effort ? sc.tasks.checkEffort(next.routing.llm.runner, patch.effort) : undefined;
          if (llmWhy) return sc.bad(llmWhy);
          if (next.routing.llm.enabled && !sc.adapterMap.has(next.routing.llm.runner)) return sc.bad(`runner "${next.routing.llm.runner}" is not installed`);
        }
        if (data.outbound) next.outbound = { ...next.outbound, ...data.outbound };
        // Shadow run: the default shadow runner must be detected; null switches the default off.
        if (data.shadowRunner !== undefined) {
          if (!shadowChoosable(sc, data.shadowRunner)) return sc.bad(shadowRefusal(sc, data.shadowRunner));
          next.shadowRunner = data.shadowRunner;
        }
        // The automatic judgement: a partial patch; a runner that is not detected cannot be chosen
        if (data.judge) {
          const patch = data.judge;
          if (patch.runner !== undefined && !choosable(patch.runner, shipped.judge.runner)) return sc.bad(`runner "${patch.runner}" is not installed`);
          const judgeRunnerChanged = patch.runner !== undefined && patch.runner !== next.judge.runner;
          next.judge = { ...next.judge, ...(judgeRunnerChanged ? { model: "", effort: "" } : {}), ...patch };
          const judgeWhy = patch.effort ? sc.tasks.checkEffort(next.judge.runner, patch.effort) : undefined;
          if (judgeWhy) return sc.bad(judgeWhy);
        }
        // The rubric judge: on / off only; the runner and model are the judge's
        // The main reviewer of a PR: it takes effect through the skills rendered at a Task's next start or resume, and at once where a review job picks its runner
        if (data.reviewRunner !== undefined) next.reviewRunner = data.reviewRunner;
        // Who reads a recheck and an audit: null (handled above) unsets it, back to following the review setting
        if (data.recheckRunner !== undefined) next.recheckRunner = data.recheckRunner;
        // A review job's model and effort, written as defaultModel / defaultEffort are; empty = the Task's default
        for (const [runner, model] of Object.entries(data.reviewModel ?? {})) {
          if (model === null) {
            delete next.reviewModel[runner];
            continue;
          }
          const adapter = sc.adapterMap.get(runner as RunnerId);
          if (!adapter) return sc.bad(`runner "${runner}" is not installed`);
          if (!adapter.models) return sc.bad(`runner "${runner}" has no model to choose`);
          if (model.trim() === "") return sc.bad("model must not be empty (null removes it)");
          next.reviewModel[runner] = model.trim();
        }
        for (const [runner, effort] of Object.entries(data.reviewEffort ?? {})) {
          if (effort === null) {
            delete next.reviewEffort[runner];
            continue;
          }
          const why = sc.tasks.checkEffort(runner as RunnerId, effort); // also refuses a runner that is not installed
          if (why) return sc.bad(why);
          next.reviewEffort[runner] = effort;
        }
        if (data.maxRunners !== undefined) next.maxRunners = data.maxRunners;
        if (data.developSelf !== undefined) next.developSelf = data.developSelf;
        if (data.autoDirect !== undefined) next.autoDirect = data.autoDirect;
        if (data.titles) {
          const patch = data.titles;
          if (patch.runner !== undefined && !choosable(patch.runner, shipped.titles.runner)) return sc.bad(`runner "${patch.runner}" is not installed`);
          const titlesRunnerChanged = patch.runner !== undefined && patch.runner !== next.titles.runner;
          next.titles = { ...next.titles, ...(titlesRunnerChanged ? { model: "", effort: "" } : {}), ...patch };
          const titlesWhy = patch.effort ? sc.tasks.checkEffort(next.titles.runner, patch.effort) : undefined;
          if (titlesWhy) return sc.bad(titlesWhy);
        }
        if (data.evals?.judge?.enabled !== undefined) next.evals = { ...next.evals, judge: { ...next.evals.judge, enabled: data.evals.judge.enabled } };
        // The Tasks that start by themselves: the runner must be detected. A runner change without a model
        // goes back to that runner's CLI default (a model belongs to one runner); so does the effort. A sent
        // effort must be one the runner lists; a kept one is not checked again (startMetaTask drops it if stale).
        // A kind's own choice follows the same rules over that kind's saved one, else over the common
        // values; null removes it (back to the common values). The common runner's change leaves the kinds alone.
        if (data.autoStart) {
          const { byKind, ...patch } = data.autoStart;
          if (patch.runner !== undefined && !sc.adapterMap.has(patch.runner)) return sc.bad(`runner "${patch.runner}" is not installed`);
          // the fallback order is replaced whole; a runner it adds must be detected. One already in the saved
          // order may stay while it is not detected (fallbackRunner skips it), so the order can still be edited around it.
          const missing = patch.fallback?.find((r) => !sc.adapterMap.has(r) && !next.autoStart.fallback.includes(r));
          if (missing) return sc.bad(`runner "${missing}" is not installed`);
          const runnerChanged = patch.runner !== undefined && patch.runner !== next.autoStart.runner;
          next.autoStart = { ...next.autoStart, ...(runnerChanged ? { model: "", effort: "" } : {}), ...patch };
          const why = patch.effort ? sc.tasks.checkEffort(next.autoStart.runner, patch.effort) : undefined;
          if (why) return sc.bad(why);
          for (const kind of AutoStartKind.options) {
            const kindPatch = byKind?.[kind];
            if (kindPatch === undefined) continue;
            if (kindPatch === null) {
              delete next.autoStart.byKind[kind];
              continue;
            }
            if (kindPatch.runner !== undefined && !sc.adapterMap.has(kindPatch.runner)) return sc.bad(`runner "${kindPatch.runner}" is not installed`);
            const saved = next.autoStart.byKind[kind];
            const { model, effort } = saved ?? next.autoStart;
            // a change is against the runner the kind starts on now: its own, else the common one it follows
            const kindRunnerChanged = kindPatch.runner !== undefined && kindPatch.runner !== (saved?.runner ?? next.autoStart.runner);
            const { permissionMode: modePatch, budgetUsd: budgetPatch, shadow: shadowPatch, ...rest } = kindPatch;
            // a kind that changes only its permission mode keeps following the common runner (no runner of its own);
            // a model or an effort belongs to one runner, so it pins the common runner to the kind as the no-choice case does
            const pins = kindPatch.runner !== undefined || kindPatch.model !== undefined || kindPatch.effort !== undefined;
            const base: AutoStartChoice = saved ? (saved.runner || !pins ? saved : { ...saved, runner: next.autoStart.runner }) : pins ? { runner: next.autoStart.runner, model, effort } : { model: "", effort: "" };
            const choice: AutoStartChoice = { ...base, ...(kindRunnerChanged ? { model: "", effort: "", permissionMode: undefined } : {}), ...rest };
            const choiceRunner = choice.runner ?? next.autoStart.runner;
            const kindWhy = kindPatch.effort ? sc.tasks.checkEffort(choiceRunner, kindPatch.effort) : undefined;
            if (kindWhy) return sc.bad(kindWhy);
            if (modePatch === null) delete choice.permissionMode;
            else if (modePatch !== undefined) {
              const modeWhy = sc.tasks.checkPermissionMode(choiceRunner, modePatch);
              if (modeWhy) return sc.bad(modeWhy);
              if (sc.adapterMap.get(choiceRunner)?.permissionModes?.find((m) => m.value === modePatch)?.danger) return sc.bad(`"${modePatch}" skips approvals and cannot be a default; choose it per task`);
              choice.permissionMode = modePatch;
            }
            if (budgetPatch === null) delete choice.budgetUsd;
            else if (budgetPatch !== undefined) choice.budgetUsd = budgetPatch;
            if (shadowPatch === null) delete choice.shadow;
            else if (shadowPatch !== undefined) choice.shadow = shadowPatch;
            // a runner change onto the kind's saved 並走 drops it, as it drops the mode; one sent with the change is checked below
            if (kindRunnerChanged && shadowPatch === undefined && choice.shadow === choiceRunner) delete choice.shadow;
            // a shadow is another runner than the one the kind starts on, and one that is detected
            if (choice.shadow && choice.shadow !== "off") {
              if (choice.shadow === choiceRunner) return sc.bad("shadowRunner must differ from runner");
              // one chosen in this PATCH must be choosable; one saved earlier stays through a change of another field as long as it is detected
              if (shadowPatch !== undefined ? !shadowChoosable(sc, choice.shadow) : !sc.adapterMap.has(choice.shadow)) return sc.bad(shadowRefusal(sc, choice.shadow));
            }
            if (!choice.runner && !choice.permissionMode && !choice.budgetUsd && !choice.shadow && !choice.model && !choice.effort) delete next.autoStart.byKind[kind];
            else next.autoStart.byKind[kind] = choice;
          }
          // Task ごとの実装のモデル: a Claude model of claude's list, while 実装 runs on claude. A later runner change keeps it; the start leaves it out then
          const taskModel = patch.completeTaskModel;
          if (taskModel) {
            if ((next.autoStart.byKind.complete?.runner ?? next.autoStart.runner) !== "claude") return sc.bad("Task ごとのモデルは「実装」のランナーが claude のときだけ選べます");
            const listed = (sc.savedModels("claude") ?? sc.adapterMap.get("claude")?.models ?? []).map((m) => m.value);
            if (!listed.includes(taskModel) || !subagentModelAlias(taskModel)) return sc.bad(`model "${taskModel}" is not one of claude's`);
          }
        }
        // The tunables: a partial patch over the saved group. Read on every use, so the next use takes the new value without a restart.
        const { quotaAndResume: qr, kernel: kn, judgeAndChoice: jc, newDefaults: nd, release: rel, cliUpdate: cu } = data;
        if (rel !== undefined) next.release = { ...next.release, ...rel };
        if (cu !== undefined) next.cliUpdate = { ...next.cliUpdate, ...cu };
        if (qr !== undefined) next.quotaAndResume = { ...next.quotaAndResume, ...qr };
        if (kn !== undefined) next.kernel = { ...next.kernel, ...kn };
        const fallbackRunnerChanged = jc?.judgeFallbackRunner !== undefined && jc.judgeFallbackRunner !== next.judgeAndChoice.judgeFallbackRunner;
        const taskRunnerChanged = nd?.taskRunner !== undefined && nd.taskRunner !== next.newDefaults.taskRunner;
        if (jc !== undefined) next.judgeAndChoice = { ...next.judgeAndChoice, ...(fallbackRunnerChanged ? { judgeFallbackModel: "", judgeFallbackEffort: "" } : {}), ...jc };
        if (nd !== undefined) next.newDefaults = { ...next.newDefaults, ...(taskRunnerChanged ? { taskModel: "", taskEffort: "" } : {}), ...nd };
        if (jc?.judgeFallbackEffort) {
          const why = sc.tasks.checkEffort(next.judgeAndChoice.judgeFallbackRunner, jc.judgeFallbackEffort);
          if (why) return sc.bad(why);
        }
        if (nd?.taskEffort) {
          const why = sc.tasks.checkEffort(next.newDefaults.taskRunner, nd.taskEffort);
          if (why) return sc.bad(why);
        }
        if (next.quotaAndResume.retryMaxDelayMs < next.quotaAndResume.retryDelayMs) return sc.bad("retryMaxDelayMs must not be shorter than retryDelayMs");
        if (jc?.judgeFallbackRunner !== undefined && !choosable(jc.judgeFallbackRunner, shipped.judgeAndChoice.judgeFallbackRunner)) return sc.bad(`runner "${jc.judgeFallbackRunner}" is not installed`);
        if (nd?.taskRunner !== undefined && !choosable(nd.taskRunner, shipped.newDefaults.taskRunner)) return sc.bad(`runner "${nd.taskRunner}" is not installed`);
        if (nd?.scheduleCron !== undefined) {
          try {
            parseCron(nd.scheduleCron);
          } catch (e) {
            return sc.bad(String((e as Error).message ?? e));
          }
        }
        // Model prices: a blank model name is refused; null drops the row (back to pricing.json's row)
        for (const [model, row] of Object.entries(data.prices ?? {})) {
          const name = model.trim();
          if (!name) return sc.bad("model name is empty");
          if (row === null) delete next.prices[name];
          else next.prices[name] = row;
        }
        sc.db.setSetting(SETTINGS_KEY, next);
        sc.logOp(req, srv, "settings.update", { detail: { keys: Object.keys(parsed.data) } });
        // a raised limit starts the Tasks that waited for it
        if (parsed.data.maxRunners !== undefined) sc.tasks.drain();
        // the next check of the newest tag comes after the saved interval, counted from now
        if (parsed.data.release !== undefined) sc.armPromotionCheck();
        // … and the next read of the CLI distributors, as saved
        if (parsed.data.cliUpdate !== undefined) sc.armCliUpdateCheck();
        return sc.json({ ...next, runners: sc.runnerInfo(), defaults: sc.settingsDefaults() });
      }),
    },
  };
}
