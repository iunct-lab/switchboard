import { expect, test } from "bun:test";
import type { Workspace } from "@switchboard/protocol";
import { developSelfPerOpening, feedbackModes, feedbackTargets, sentMode } from "./feedbackTarget.ts";

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

test("feedbackModes: off hides fix and sends Switchboard requests upstream", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(feedbackModes(false, ws("ws_meta", "meta"), list)).toEqual({ fix: false, upstream: true });
  // a dialog opened for no workspace files in the meta workspace
  expect(feedbackModes(false, undefined, list)).toEqual({ fix: false, upstream: true });
  // the user's own app still makes a Task
  expect(feedbackModes(false, ws("ws_lib"), list)).toEqual({ fix: false, upstream: false });
});

test("feedbackModes: on keeps both as today", () => {
  const list = [ws("ws_lib"), ws("ws_meta", "meta")];
  expect(feedbackModes(true, ws("ws_meta", "meta"), list)).toEqual({ fix: true, upstream: false });
  expect(feedbackModes(true, ws("ws_lib"), list)).toEqual({ fix: true, upstream: false });
});

test("developSelfPerOpening: each opening starts off and a late answer for an earlier opening is dropped", async () => {
  const seen: boolean[] = [];
  const answers: ((on: boolean) => void)[] = [];
  const open = developSelfPerOpening(() => new Promise<boolean>((r) => answers.push(r)), (on) => seen.push(on));
  const first = open(); // opened while developing
  const second = open(); // closed, the setting turned off, reopened before the first answer came
  answers[1]!(false);
  answers[0]!(true); // the first opening's slow answer
  await Promise.all([first, second]);
  expect(seen).toEqual([false, false, false]);
  const third = open();
  answers[2]!(true);
  await third;
  expect(seen.at(-1)).toBe(true);
});

test("sentMode: すぐ直す kept from before the setting was turned off goes as a request", () => {
  expect(sentMode({ fix: false }, "fix")).toBe("request");
  expect(sentMode({ fix: true }, "fix")).toBe("fix");
  expect(sentMode({ fix: false }, "request")).toBe("request");
});
