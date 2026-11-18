import { expect, test } from "bun:test";
import { afterClose, ptyQuery, targetRefusal } from "./terminalReconnect.ts";

test("a shell that exited, or was gone when the socket came back, ends with 開き直す; nothing starts on its own", () => {
  expect(afterClose(1000, "s1", 0)).toEqual({ kind: "ended", message: "Terminalは終了しました。", reopen: true });
  expect(afterClose(4404, "s1", 3)).toEqual({ kind: "ended", message: "Terminalは終了していました。", reopen: true });
});

test("a dropped connection to a known shell is tried again, 500 ms doubling up to 8 s", () => {
  expect([0, 1, 2, 3, 4, 5, 10].map((n) => afterClose(1006, "s1", n))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000].map((delayMs) => ({ kind: "retry", delayMs })));
});

test("a drop before the daemon named the shell is not retried", () => {
  expect(afterClose(1006, null, 0)).toEqual({ kind: "ended", message: "ターミナルとの接続が切れました。", reopen: true });
});

test("ptyQuery names the shell only when there is one; a Workspace's terminal never asks for Teleport", () => {
  expect(ptyQuery({ task: "t1" }, null)).toEqual({ task: "t1" });
  expect(ptyQuery({ task: "t1" }, "s1")).toEqual({ task: "t1", shell: "s1" });
  expect(ptyQuery({ task: "t1" }, "s1", true)).toEqual({ task: "t1", teleport: "1", shell: "s1" });
  expect(ptyQuery({ workspace: "ws_1" }, null, true)).toEqual({ workspace: "ws_1" });
  expect(ptyQuery({ workspace: "ws_1" }, "s2")).toEqual({ workspace: "ws_1", shell: "s2" });
});

test("a terminal the daemon refuses for its target shows the daemon's line; a plain GET's answer, a login refusal and a body without a line do not", () => {
  const line = "この Task は pc1 で動きました。ターミナルは pc1 で開きます。";
  expect(targetRefusal(409, { error: line })).toBe(line);
  expect(targetRefusal(404, { error: "task not found" })).toBe("task not found");
  expect(targetRefusal(426, { error: "websocket upgrade failed" })).toBeNull();
  expect(targetRefusal(401, { error: "unauthorized", reason: "recent" })).toBeNull();
  expect([targetRefusal(409, {}), targetRefusal(409, { error: " " }), targetRefusal(409, null), targetRefusal(409, { error: 5 })]).toEqual([null, null, null, null]);
});
