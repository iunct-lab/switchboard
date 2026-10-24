import { expect, test } from "bun:test";
import { CloudSessionRef, CreateTaskInput } from "./model.ts";

test("creation defaults Local and preserves explicit Cloud", () => {
  expect(CreateTaskInput.parse({ title: "task", prompt: "explain" }).executionMode).toBe("local");
  expect(CreateTaskInput.parse({ title: "task", prompt: "explain", executionMode: "cloud" }).executionMode).toBe("cloud");
});

test("Cloud references reject foreign hosts, credentials, query strings and mismatched IDs", () => {
  const id = "session_0123456789abcdefghijklmn";
  expect(CloudSessionRef.parse({ id, url: `https://claude.ai/code/${id}` }).id).toBe(id);
  for (const url of [`http://claude.ai/code/${id}`, `https://example.com/code/${id}`, `https://user@claude.ai/code/${id}`, `https://claude.ai/code/${id}?code=secret`, `https://claude.ai/code/session_other`, `https://claude.ai/code/${id}#secret`]) {
    expect(CloudSessionRef.safeParse({ id, url }).success).toBe(false);
  }
});
