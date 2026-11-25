import { describe, expect, test } from "bun:test";
import { NewDefaultsSettings, Settings, type RunnerInfo } from "@switchboard/protocol";
import { AUTO_START_KINDS, initialChoice, jobPatchOf, jobRows, runnerDefaultLabel, candidatesOf, effectiveDefaultEffort, homeEmptyLabel, kindChoice, kindPick, modelsRowView, resetPatch, runnerRows, showsCliCandidates } from "./runnerSettings.ts";

const opt = (value: string) => ({ value, label: value });
const info = (p: Partial<RunnerInfo> & { id: string }): RunnerInfo => ({ available: true, permissionModes: [], models: [], efforts: [], ...p }) as RunnerInfo;
const claude = info({ id: "claude", models: [opt("opus")], efforts: [opt("high")], permissionModes: [{ value: "default", label: "d" }], subagents: true });
const codex = info({ id: "codex", models: [opt("gpt-6")], efforts: [opt("low"), opt("high")], permissionModes: [{ value: "on-request", label: "r" }], defaultModel: "gpt-6-luna", defaultEffort: "low" });
const adk = info({ id: "custom:x" });

describe("runnerRows", () => {
  test("claude and codex show the same rows in the same order", () => {
    expect(runnerRows(claude).map((r) => r.key)).toEqual(runnerRows(codex).map((r) => r.key));
  });
  test("a runner without subagents keeps the two subagent rows, not editable", () => {
    expect(runnerRows(codex).filter((r) => r.key.startsWith("subagent")).map((r) => r.editable)).toEqual([false, false]);
    expect(runnerRows(claude).filter((r) => r.key.startsWith("subagent")).map((r) => r.editable)).toEqual([true, true]);
  });
  test("an ADK runner still has all 7 rows, none editable", () => {
    const rows = runnerRows(adk);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => !r.editable)).toBe(true);
  });
  test("the model list is not editable for a bedrock login", () => {
    expect(runnerRows({ ...claude, loginKind: "bedrock" }).find((r) => r.key === "models")?.editable).toBe(false);
    expect(runnerRows(claude).find((r) => r.key === "models")?.editable).toBe(true);
  });
  test("a bedrock login cannot edit its list but keeps the CLI candidates; a runner without a list has none", () => {
    expect(showsCliCandidates({ ...claude, loginKind: "bedrock" })).toBe(true);
    expect(showsCliCandidates(codex)).toBe(true);
    expect(showsCliCandidates(adk)).toBe(false);
    expect(showsCliCandidates(info({ id: "custom:y", models: [opt("m")] }))).toBe(false);
  });
  test("the モデルの選択肢 row is shown for every runner: list, candidates only, or the plain 変えられない row", () => {
    expect(modelsRowView(claude)).toEqual({ folded: true, list: true, candidates: true });
    expect(modelsRowView({ ...claude, loginKind: "bedrock" })).toEqual({ folded: true, list: false, candidates: true });
    expect(modelsRowView(adk)).toEqual({ folded: false, list: false, candidates: false });
    expect(modelsRowView(info({ id: "dak" }))).toEqual({ folded: false, list: false, candidates: false });
  });
});

describe("jobRows", () => {
  const rows = jobRows(Settings.parse({ autoStart: { byKind: { fix: { runner: "codex", model: "m", effort: "e" }, complete: {} } } }), ["claude", "codex"]);
  test("every row has a runner, a model and an effort", () => {
    for (const r of rows) {
      expect(typeof r.runner).toBe("string");
      expect(typeof r.model).toBe("string");
      expect(typeof r.effort).toBe("string");
    }
  });
  test("order: manual, common, only the kinds with their own choice, then the rest", () => {
    expect(rows.map((r) => r.id)).toEqual(["manual", "autoStart", "kind:fix", "kind:complete", "review", "recheck", "reviewModel:claude", "reviewModel:codex", "judge", "judgeFallback", "routing", "titles"]);
    expect(rows.find((r) => r.id === "kind:fix")).toMatchObject({ runner: "codex", model: "m", effort: "e" });
    expect(rows.find((r) => r.id === "kind:complete")?.runner).toBe("same");
    const kinds = AUTO_START_KINDS.map(([k]) => k);
    expect(kinds.indexOf("fix")).toBeLessThan(kinds.indexOf("complete"));
  });
  test("review is a runner choice only", () => {
    expect(rows.find((r) => r.id === "review")).toMatchObject({ runner: "other", model: "", effort: "", runnerOnly: true });
  });
  test("jobRows: recheck and review model rows", () => {
    // the defaults: the recheck is unset (it follows the review setting), and each review runner's model / effort is the runner's default
    expect(rows.find((r) => r.id === "recheck")).toMatchObject({ runner: "", model: "", effort: "", runnerOnly: true });
    expect(rows.find((r) => r.id === "reviewModel:claude")).toMatchObject({ runner: "claude", model: "", effort: "" });
    expect(rows.find((r) => r.id === "reviewModel:codex")).toMatchObject({ runner: "codex", model: "", effort: "" });
    // the saved values come out as they are, each on its own runner's row
    const saved = jobRows(Settings.parse({ recheckRunner: "same", reviewModel: { codex: "gpt-6" }, reviewEffort: { claude: "high", codex: "low" } }), ["claude", "codex"]);
    expect(saved.find((r) => r.id === "recheck")?.runner).toBe("same");
    expect(saved.find((r) => r.id === "reviewModel:claude")).toMatchObject({ runner: "claude", model: "", effort: "high" });
    expect(saved.find((r) => r.id === "reviewModel:codex")).toMatchObject({ runner: "codex", model: "gpt-6", effort: "low" });
    // only the runners passed in get a row
    expect(jobRows(Settings.parse({ reviewModel: { codex: "gpt-6" } }), ["claude"]).filter((r) => r.id.startsWith("reviewModel:")).map((r) => r.id)).toEqual(["reviewModel:claude"]);
  });
  test("the titles row reads the saved titles setting", () => {
    expect(rows.find((r) => r.id === "titles")).toMatchObject({ runner: "codex", model: "gpt-6-luna" });
  });
});

describe("initialChoice", () => {
  const nd = NewDefaultsSettings.parse({ taskRunner: "claude", taskModel: "opus", taskEffort: "high" });
  test("the runner's own default when hand-started Tasks are on another runner", () => {
    expect(initialChoice("codex", codex, nd)).toEqual({ model: "gpt-6-luna", effort: "low" });
  });
  test("the saved hand-start choice wins on its runner", () => {
    expect(initialChoice("claude", claude, nd)).toEqual({ model: "opus", effort: "high" });
  });
  test("the suggestion's model wins when it is for this runner", () => {
    expect(initialChoice("codex", codex, nd, { runner: "codex", model: "gpt-6-x" })).toEqual({ model: "gpt-6-x", effort: "low" });
    expect(initialChoice("codex", codex, nd, { runner: "claude", model: "opus" }).model).toBe("gpt-6-luna");
  });
  test("nothing saved: empty (the CLI's own default)", () => {
    expect(initialChoice("claude", undefined, NewDefaultsSettings.parse({}))).toEqual({ model: "", effort: "" });
  });
});

describe("a saved default effort the runner no longer lists (the daemon drops it and runs on the CLI's own)", () => {
  const stale = { ...codex, efforts: [opt("high")] }; // defaultEffort "low" is not listed
  test("effectiveDefaultEffort reads it as unset; a listed one stays", () => {
    expect(effectiveDefaultEffort(stale)).toBeUndefined();
    expect(effectiveDefaultEffort(codex)).toBe("low");
    expect(effectiveDefaultEffort({ ...codex, efforts: [] })).toBeUndefined();
    expect(effectiveDefaultEffort(undefined)).toBeUndefined();
  });
  test("the job rows' empty choice, Home's name and Home's first effort all say the CLI default, not the stale value", () => {
    expect(runnerDefaultLabel("effort", stale)).toBe("ランナーの既定（CLI 既定）");
    expect(homeEmptyLabel("effort", stale)).toBeUndefined();
    expect(initialChoice("codex", stale, NewDefaultsSettings.parse({ taskRunner: "claude" })).effort).toBe("");
  });
});

describe("runnerDefaultLabel", () => {
  test("names what the empty choice comes to: the saved default (by its label), else the CLI's model, else the CLI's default", () => {
    expect(runnerDefaultLabel("model", { ...codex, models: [{ value: "gpt-6-luna", label: "Luna" }] })).toBe("ランナーの既定（Luna）");
    expect(runnerDefaultLabel("effort", codex)).toBe("ランナーの既定（low）");
    expect(runnerDefaultLabel("model", { ...claude, cliDefaultModel: "opus-x" })).toBe("ランナーの既定（opus-x）");
    expect(runnerDefaultLabel("effort", claude)).toBe("ランナーの既定（CLI 既定）");
    expect(runnerDefaultLabel("model", undefined)).toBe("ランナーの既定（CLI 既定）");
  });
});

describe("jobPatchOf", () => {
  test("each job row saves to its own setting, with only the fields that changed", () => {
    const c = { runner: "codex", model: "m", effort: "high" } as const;
    expect(jobPatchOf("manual", c)).toEqual({ newDefaults: { taskRunner: "codex", taskModel: "m", taskEffort: "high" } });
    expect(jobPatchOf("autoStart", c)).toEqual({ autoStart: c });
    expect(jobPatchOf("judge", c)).toEqual({ judge: c });
    expect(jobPatchOf("judgeFallback", c)).toEqual({ judgeAndChoice: { judgeFallbackRunner: "codex", judgeFallbackModel: "m", judgeFallbackEffort: "high" } });
    expect(jobPatchOf("routing", c)).toEqual({ routing: { llm: c } });
    expect(jobPatchOf("titles", c)).toEqual({ titles: c });
    expect(jobPatchOf("judge", { model: "" })).toEqual({ judge: { model: "" } });
  });
  test("every job row but the kinds', the review's, the recheck's and the review models' (saved by their own controls) has its own setting", () => {
    const ids = jobRows(Settings.parse({}), ["claude"]).map((r) => r.id).filter((id) => !id.startsWith("kind:") && !id.startsWith("reviewModel:") && id !== "review" && id !== "recheck");
    const keys = ids.map((id) => Object.keys(jobPatchOf(id, { model: "x" }))[0]);
    expect(keys).toEqual(ids.map((id) => ({ manual: "newDefaults", autoStart: "autoStart", judge: "judge", judgeFallback: "judgeAndChoice", routing: "routing", titles: "titles" })[id as string]));
  });
});

describe("resetPatch", () => {
  test("a runner block puts back that runner's six values and nothing else", () => {
    const p = resetPatch({ runner: "codex" });
    expect(Object.keys(p).sort()).toEqual(["autoResume", "defaultEffort", "defaultModel", "defaultPermissionMode", "subagentEffort", "subagentModel"]);
    for (const v of Object.values(p)) expect(v).toEqual({ codex: null });
  });
});

describe("candidatesOf", () => {
  test("a runner's block lists only its own runner's candidates (and errors)", () => {
    const found = [{ runner: "claude", candidates: [opt("opus")] }, { runner: "codex", candidates: [opt("gpt-6")] }, { runner: "codex", error: "x" }];
    expect(candidatesOf(found, [claude])).toEqual([{ runner: "claude", candidates: [opt("opus")] }]);
    expect(candidatesOf(found, [codex]).map((r) => r.runner)).toEqual(["codex", "codex"]);
    expect(candidatesOf(found, [claude, codex])).toEqual(found);
  });
});

describe("homeEmptyLabel", () => {
  test("Home names the empty choice after the runner's saved default; with none saved, the select keeps its CLI 既定", () => {
    expect(homeEmptyLabel("model", { ...codex, models: [{ value: "gpt-6-luna", label: "Luna" }] })).toBe("ランナーの既定（Luna）");
    expect(homeEmptyLabel("effort", codex)).toBe("ランナーの既定（low）");
    expect(homeEmptyLabel("model", claude)).toBeUndefined();
    expect(homeEmptyLabel("effort", claude)).toBeUndefined();
    expect(homeEmptyLabel("model", undefined)).toBeUndefined();
  });
});

describe("kindChoice", () => {
  const auto = { runner: "claude", model: "opus", effort: "high" } as const;
  test("a kind with its own runner shows its own model and effort (empty = that runner's default)", () => {
    expect(kindChoice({ runner: "codex", model: "", effort: "" }, auto)).toEqual({ runner: "codex", model: "", effort: "" });
  });
  test("a kind that changed only its approval mode starts on the common row's choice, so it shows it (runner undefined = 共通)", () => {
    expect(kindChoice({ model: "", effort: "", permissionMode: "plan" }, auto)).toEqual({ runner: undefined, model: "opus", effort: "high" });
  });
  test("no choice of its own: the common row", () => {
    expect(kindChoice(undefined, auto)).toEqual({ runner: "claude", model: "opus", effort: "high" });
  });
  test("jobRows reads a kind the same way", () => {
    const s = Settings.parse({ autoStart: { runner: "claude", model: "opus", effort: "high", byKind: { complete: { permissionMode: "plan" } } } });
    expect(jobRows(s, []).find((r) => r.id === "kind:complete")).toMatchObject({ runner: "same", model: "opus", effort: "high" });
  });
});

describe("kindPick", () => {
  const shown = { model: "opus", effort: "high" };
  const efforts = { efforts: [opt("high")] };
  test("a kind without its own runner sends the other shown value along, so a model change does not drop the shown effort", () => {
    expect(kindPick({ model: "", effort: "", permissionMode: "plan" }, shown, { model: "fable" }, efforts)).toEqual({ model: "fable", effort: "high" });
    expect(kindPick({ model: "", effort: "", permissionMode: "plan" }, shown, { effort: "" }, efforts)).toEqual({ model: "opus", effort: "" });
  });
  test("a shown effort the runner no longer lists is sent as empty (the daemon would refuse it)", () => {
    expect(kindPick({ model: "", effort: "" }, shown, { model: "fable" }, { efforts: [opt("low")] })).toEqual({ model: "fable", effort: "" });
  });
  test("a kind with its own runner, or none of its own yet, sends just the change (the daemon keeps or copies the rest)", () => {
    expect(kindPick({ runner: "codex", model: "", effort: "high" }, shown, { model: "gpt-6" }, efforts)).toEqual({ model: "gpt-6" });
    expect(kindPick(undefined, shown, { effort: "high" }, efforts)).toEqual({ effort: "high" });
  });
});
