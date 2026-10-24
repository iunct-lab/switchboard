import { expect, test } from "bun:test";
import { copyText, type CopyEnv } from "./clipboard.ts";

const env = (clip: CopyEnv["clipboard"], exec: boolean | Error) => {
  const calls: string[] = [];
  const e: CopyEnv = {
    clipboard: clip,
    execCopy: (t) => {
      calls.push(`exec:${t}`);
      if (exec instanceof Error) throw exec;
      return exec;
    },
  };
  return { e, calls };
};

test("uses clipboard.writeText when present", async () => {
  const written: string[] = [];
  const { e, calls } = env({ writeText: async (t) => void written.push(t) }, true);
  await copyText("a\n  b", e);
  expect(written).toEqual(["a\n  b"]);
  expect(calls).toEqual([]);
});

test("falls back to execCopy when clipboard is missing or rejects", async () => {
  const missing = env(undefined, true);
  await copyText("x", missing.e);
  expect(missing.calls).toEqual(["exec:x"]);
  const rejects = env({ writeText: () => Promise.reject(new Error("NotAllowedError")) }, true);
  await copyText("y", rejects.e);
  expect(rejects.calls).toEqual(["exec:y"]);
});

test("throws when both fail", async () => {
  await expect(copyText("x", env(undefined, false).e)).rejects.toThrow("クリップボードにコピーできませんでした");
  await expect(copyText("x", env({ writeText: () => Promise.reject(new Error("no")) }, new Error("boom")).e)).rejects.toThrow("クリップボードにコピーできませんでした");
});
