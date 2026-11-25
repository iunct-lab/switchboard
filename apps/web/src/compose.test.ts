import { expect, test } from "bun:test";
import type { Workspace } from "@switchboard/protocol";
import { backlogTargetName, feedbackArgs } from "./compose.ts";

const ws = (id: string, kind: Workspace["kind"] = "repo") => ({ id, name: `name-${id}`, path: `/${id}`, kind }) as Workspace;
const base = { text: "直したい", attachmentIds: ["a1"], screen: "Home" };

test("request は workspaceId と source を付け、fix は付けない", () => {
  const source = { kind: "eval" as const, taskId: "task_1" };
  expect(feedbackArgs("request", { ...base, workspaceId: "ws_lib", source })).toEqual(["直したい", ["a1"], "Home", "request", "ws_lib", source]);
  expect(feedbackArgs("fix", { ...base, workspaceId: "ws_lib", source })).toEqual(["直したい", ["a1"], "Home", "fix", undefined, undefined]);
  // 自動 (null): nothing names the repository, so the daemon files it in Switchboard itself as before
  expect(feedbackArgs("request", { ...base, workspaceId: null })[4]).toBeUndefined();
});

test("自動のときの登録先は meta", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(backlogTargetName(list, "")).toBe("name-ws_meta");
  expect(backlogTargetName(list, "ws_lib")).toBe("name-ws_lib");
  expect(backlogTargetName([ws("ws_lib")], "")).toBe("");
});
