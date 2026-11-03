import { expect, test } from "bun:test";
import { watchHealth } from "./healthWatch.ts";

test("health is read again when the page comes back and every interval while visible, not while hidden (#1600)", async () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  let reads = 0;
  const stop = watchHealth(doc, () => reads++, 20);
  // load (the flake of #2939): a fixed 50 ms was too short for two 20 ms ticks on a busy host, so wait for the count
  for (const t0 = Date.now(); reads < 2 && Date.now() - t0 < 2000; ) await Bun.sleep(5);
  expect(reads).toBeGreaterThanOrEqual(2); // the interval while visible
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  const hidden = reads;
  await Bun.sleep(50);
  expect(reads).toBe(hidden); // nothing while hidden
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(reads).toBe(hidden + 1); // at once when it comes back
  stop();
  const stopped = reads;
  await Bun.sleep(50);
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(reads).toBe(stopped);
});
