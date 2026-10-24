import { expect, test } from "bun:test";
import type { Workspace } from "@switchboard/protocol";
import { feedbackTargets } from "./feedbackTarget.ts";

const ws = (id: string, kind: Workspace["kind"] = "repo") => ({ id, name: id, path: `/${id}`, kind }) as Workspace;

test("a request goes where it was opened for, else to the meta workspace", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(feedbackTargets(list, ws("ws_lib"))).toEqual({ list, initial: "ws_lib" });
  expect(feedbackTargets(list)).toEqual({ list, initial: "ws_meta" });
  // the backlog read a workspace App's older list does not have yet: it is offered and chosen, so the selector shows
  // what is sent (not the first option while the request goes elsewhere)
  const fresh = { id: "ws_new", name: "new" };
  expect(feedbackTargets([ws("ws_meta", "meta")], fresh)).toEqual({ list: [ws("ws_meta", "meta"), fresh], initial: "ws_new" });
  // nothing loaded yet: the daemon's default (the meta workspace)
  expect(feedbackTargets([])).toEqual({ list: [], initial: "" });
});
