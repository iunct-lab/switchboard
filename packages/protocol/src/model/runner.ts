import { z } from "zod";
import { RunnerId } from "../events.ts";

/** One selectable permission mode of a runner, as the UI lists it. `danger` marks modes that skip approvals. */
export const PermissionModeOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string(),
  danger: z.boolean().optional(),
});
export type PermissionModeOption = z.infer<typeof PermissionModeOption>;

/** A model the runner accepts as `StartOptions.model`. The list is the adapter's; anything else can still be typed. */
export const ModelOption = z.object({ value: z.string(), label: z.string() });
export type ModelOption = z.infer<typeof ModelOption>;

/** The runner's own login: `ok`, `expired` (its status command or the last turn said not logged in), `unknown`. */
export const RunnerLogin = z.enum(["ok", "expired", "unknown"]);
export type RunnerLogin = z.infer<typeof RunnerLogin>;

/** Which login is in use: `claude.ai` = a Claude account, `console` = an Anthropic Console account. Only from `claude auth status`'s `authMethod`; no account name, email or organization. */
export const LoginKind = z.enum(["claude.ai", "console", "bedrock"]);
export type LoginKind = z.infer<typeof LoginKind>;

/**
 * A server the person added in Settings (docs/design/custom-adapter.md): it runs as the runner `custom:<name>`.
 * `port` says which protocol it speaks: `adk` (an ADK server) or `agui` (an AG-UI endpoint).
 * Saved in the `settings` table under its own key, not in `Settings`, so an older daemon that writes `Settings` back
 * cannot drop it. There is no field for a token's value: only the name of the environment variable that holds it.
 */
const CustomRunnerBase = {
  /** The part after `custom:` in the runner's id. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  /** The name the person knows the runner by. */
  label: z.string().trim().min(1).max(60),
  url: z.url({ protocol: /^https?$/ }),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
};
export const CustomRunner = z.discriminatedUnion("port", [
  z
    .object({
      port: z.literal("adk"),
      ...CustomRunnerBase,
      /** The ADK app name. */
      app: z.string().trim().min(1).max(100),
      /** Artifacts whose name starts with this are the agent's own and are not fetched. */
      artifactSkipPrefix: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      port: z.literal("agui"),
      ...CustomRunnerBase,
      /** Hand the Task's Workspace MCP endpoint and token to the agent. Off by default: it sends a credential. */
      sendWorkspaceMcp: z.boolean().default(false),
    })
    .strict(),
]);
export type CustomRunner = z.infer<typeof CustomRunner>;
/** PUT /api/custom-runners: the whole list. */
export const CustomRunnerList = z.array(CustomRunner);

export const RunnerInfo = z.object({
  id: RunnerId,
  /** The name to show (a custom runner's label); absent = the id's own name. */
  label: z.string().optional(),
  available: z.boolean(),
  version: z.string().optional(),
  path: z.string().optional(),
  note: z.string().optional(),
  /** Modes the runner offers (empty = no knob; DAK). */
  permissionModes: z.array(PermissionModeOption).default([]),
  /** Effective default for new tasks: the saved setting, else the adapter's default. */
  defaultPermissionMode: z.string().optional(),
  /** Saved default model / thinking effort for new Tasks without them; absent = the CLI's own default. */
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  /** Effective subagent model (the setting `subagentModel`); absent = same as the task. */
  subagentModel: z.string().optional(),
  /** true = the runner lets the user choose the subagents' model / thinking effort (claude only). */
  subagents: z.boolean().optional(),
  /** Tasks of this runner stopped on the usage limit are resumed by the daemon once it lifts. */
  autoResume: z.boolean().optional(),
  /** Models the runner offers (empty = the runner decides itself; DAK). */
  models: z.array(ModelOption).default([]),
  /** Thinking efforts the runner offers (empty = the runner decides itself; DAK). */
  efforts: z.array(ModelOption).default([]),
  /** What the CLI runs a task on when its model is left empty (the user's own CLI setting); absent = not known. */
  cliDefaultModel: z.string().optional(),
  /** Absent = the runner has no login of its own (DAK). */
  login: RunnerLogin.optional(),
  /** Which login `login: "ok"` is; absent = not known (an older CLI, another runner, or not logged in). `bedrock` = Amazon Bedrock, chosen in the settings or set in the CLI's own settings (`bedrockFrom`). */
  loginKind: LoginKind.optional(),
  /** Where `loginKind: "bedrock"` comes from: `settings` = the user chose it here, `cli` = the CLI's own settings. */
  bedrockFrom: z.enum(["settings", "cli"]).optional(),
  /** When the login runs out, epoch ms; absent = not known (an older CLI, another runner, not logged in, or Bedrock). */
  loginExpiresAt: z.number().optional(),
  /** Tasks started on Amazon Bedrock that are still working (running, waiting, or background); absent = none. They stay on Bedrock when the setting goes back. */
  bedrockRunning: z.number().optional(),
  /** The model list to edit (the saved one, else the adapter's); on Bedrock `models` is the same list by Bedrock ids. Absent = not on Bedrock, `models` is it. */
  listModels: z.array(ModelOption).optional(),
  /** The runner can run on Amazon Bedrock (its adapter has `bedrockModel`). */
  bedrockAvailable: z.boolean().default(false),
  /** What to type in a terminal tab to log in again. */
  loginHint: z.string().optional(),
  /** The runner can start a Task from a past turn of another (the adapter has `forks` and the detected version is at least its `forkMinVersion`). */
  forks: z.boolean().default(false),
});
export type RunnerInfo = z.infer<typeof RunnerInfo>;

/**
 * One command or skill a runner offers after "/" in a request or reply box. `insert` is what goes into the box
 * (Claude `/<name>`, Codex `$<name>`): the screen types it as it is and has no runner-specific branch.
 */
export const RunnerCommand = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  insert: z.string(),
});
export type RunnerCommand = z.infer<typeof RunnerCommand>;
