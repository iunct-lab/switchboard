import { expect, test } from "bun:test";
import { accessLine } from "./accesslog.ts";

test("an access line carries the handler's time to 0.1 ms (#2101)", () => {
  const line = JSON.parse(accessLine({ t: Date.UTC(2026, 9, 22, 1, 2, 3), from: "203.0.113.5", method: "GET", path: "/api/tasks/t1", status: 200, auth: "cookie", ms: 12.345 }));
  expect(line).toEqual({ log: "access", t: "2026-10-22T01:02:03.000Z", from: "203.0.113.5", method: "GET", path: "/api/tasks/t1", status: 200, auth: "cookie", ms: 12.3 });
});
