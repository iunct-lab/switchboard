import { expect, test } from "bun:test";
import type { Workspace } from "@switchboard/protocol";
import { feedbackModes, startWorkspace } from "./feedbackTarget.ts";

const ws = (id: string, kind: Workspace["kind"] = "repo") => ({ id, name: id, path: `/${id}`, kind }) as Workspace;

test("the form starts on the repository it was opened for, else on 自動", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(startWorkspace(list, ws("ws_lib"))).toEqual({ initial: "ws_lib", extra: null });
  expect(startWorkspace(list)).toEqual({ initial: "", extra: null });
  // the backlog read a workspace App's older list does not have yet: it is offered and chosen, so the select shows
  // what is sent (not the first option while the request goes elsewhere)
  const fresh = { id: "ws_new", name: "new" };
  expect(startWorkspace([ws("ws_meta", "meta")], fresh)).toEqual({ initial: "ws_new", extra: fresh });
  expect(startWorkspace([])).toEqual({ initial: "", extra: null });
});

test("feedbackModes: off offers fix for another workspace, not for Switchboard itself", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(feedbackModes(false, ws("ws_meta", "meta"), list)).toEqual({ fix: false, upstream: true });
  // a form left on 自動 files in the meta workspace
  expect(feedbackModes(false, undefined, list)).toEqual({ fix: false, upstream: true });
  // the user's own app still makes a Task, and can be fixed right away
  expect(feedbackModes(false, ws("ws_lib"), list)).toEqual({ fix: true, upstream: false });
});

test("feedbackModes: on keeps both as today", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(feedbackModes(true, ws("ws_meta", "meta"), list)).toEqual({ fix: true, upstream: false });
  expect(feedbackModes(true, ws("ws_lib"), list)).toEqual({ fix: true, upstream: false });
});
