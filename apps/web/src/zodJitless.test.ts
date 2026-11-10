import { expect, test } from "bun:test";
import { z } from "zod";
import "./zodJitless.ts";

test("web turns zod's jitless on so the eval probe never runs under the CSP", () => {
  expect(z.config().jitless).toBe(true);
});
