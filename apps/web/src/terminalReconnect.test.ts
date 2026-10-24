import { expect, test } from "bun:test";
import { afterClose, ptyQuery } from "./terminalReconnect.ts";

test("a shell that exited, or was gone when the socket came back, ends with 開き直す; nothing starts on its own (#1137)", () => {
  expect(afterClose(1000, "s1", 0)).toEqual({ kind: "ended", message: "Terminalは終了しました。", reopen: true });
  expect(afterClose(4404, "s1", 3)).toEqual({ kind: "ended", message: "Terminalは終了していました。", reopen: true });
});

test("a dropped connection to a known shell is tried again, 500 ms doubling up to 8 s", () => {
  expect([0, 1, 2, 3, 4, 5, 10].map((n) => afterClose(1006, "s1", n))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000].map((delayMs) => ({ kind: "retry", delayMs })));
});

test("a drop before the daemon named the shell is not retried", () => {
  expect(afterClose(1006, null, 0)).toEqual({ kind: "ended", message: "ターミナルとの接続が切れました。", reopen: true });
});

test("ptyQuery names the shell only when there is one", () => {
  expect(ptyQuery("t1", null)).toEqual({ task: "t1" });
  expect(ptyQuery("t1", "s1")).toEqual({ task: "t1", shell: "s1" });
  expect(ptyQuery("t1", "s1", true)).toEqual({ task: "t1", teleport: "1", shell: "s1" });
});
