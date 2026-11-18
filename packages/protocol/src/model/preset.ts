import { z } from "zod";

/**
 * A saved instruction: a name and a short request text, with `{{target}}` where the chosen
 * Issue / PR goes. It carries no approval mode, runner or model — it is what to ask, never a standing permission.
 */
export const Preset = z.object({ id: z.string(), name: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(8000), createdAt: z.number(), updatedAt: z.number() });
export type Preset = z.infer<typeof Preset>;
/** POST /api/presets, PATCH (partial): any other key (`permissionMode`, `runner`, …) is 400. */
export const PresetInput = Preset.pick({ name: true, text: true }).strict();
export type PresetInput = z.infer<typeof PresetInput>;
/** Where a preset was put in: Home's request box or a Task's reply box. */
export const PresetScene = z.enum(["home", "task"]);
export type PresetScene = z.infer<typeof PresetScene>;
/** Uses of one preset in the last 14 days per scene; `lastAt` = the latest use in ms, null when none. */
export const PresetUse = z.object({ id: z.string(), home: z.number(), task: z.number(), lastAt: z.number().nullable() });
export type PresetUse = z.infer<typeof PresetUse>;
export const PresetList = z.object({ presets: z.array(Preset), uses: z.array(PresetUse) });
export type PresetList = z.infer<typeof PresetList>;
/** POST /api/presets/:id/expand: the workspace to send in and the Issue / PR (`12`, `#12`, `owner/name#12`, its URL); `scene` = where it is put in (nothing is recorded without it). */
export const PresetExpandInput = z.object({ workspaceId: z.string().optional(), target: z.string().optional(), scene: PresetScene.optional(), taskId: z.string().optional() }).strict();
export type PresetExpandInput = z.infer<typeof PresetExpandInput>;
/** A preset offered as a one-press reply under a stop: what the person answered to the same kind of stop before. */
export const PresetReply = z.object({ id: z.string(), name: z.string(), text: z.string() });
export type PresetReply = z.infer<typeof PresetReply>;
/** The text to put in the request / reply box as it will be sent; `target` = `owner/name#n`, null when not used. */
export const PresetExpansion = z.object({ title: z.string(), text: z.string(), repo: z.string().nullable(), target: z.string().nullable() });
export type PresetExpansion = z.infer<typeof PresetExpansion>;
