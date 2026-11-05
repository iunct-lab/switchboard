import { expect, test } from "bun:test";
import { createdRef, fileRequests, type Finding, MAX_REQUESTS, type RequestDeps } from "./ui-layers-requests.ts";

const finding = (n: number, source: Finding["source"] = "定期の検査"): Finding => ({ key: `k${n}`, title: `所見 ${n}`, detail: `詳細 ${n}`, source });

/** A backlog in memory: what `create` files is open on the next list. */
function fakeBacklog(open: string[] = []): RequestDeps & { bodies: string[] } {
  const titles = [...open];
  const bodies: string[] = [];
  return {
    bodies,
    listOpenRequestTitles: async () => [...titles],
    create: async (title, body) => (titles.push(title), bodies.push(body), `#${100 + titles.length}`),
  };
}

test("files MAX_REQUESTS of four findings, in order", async () => {
  const b = fakeBacklog();
  const r = await fileRequests([finding(1), finding(2, "エージェント"), finding(3), finding(4)], b, "2026-11-01");
  expect(MAX_REQUESTS).toBe(3);
  expect(r).toEqual({ created: ["#101", "#102", "#103"], duplicates: 0, overLimit: 1 });
  expect(b.bodies[1]).toContain("- 誰の言葉: エージェント\n- いつ: 2026-11-01\n");
  expect(b.bodies[0]).toContain("````text\n詳細 1\n````");
});

test("the same findings again file nothing: their titles are open requests", async () => {
  const b = fakeBacklog(["要望: 別の要望"]);
  const findings = [finding(1), finding(2)];
  expect((await fileRequests(findings, b, "2026-11-01")).created).toHaveLength(2);
  expect(await fileRequests(findings, b, "2026-12-01")).toEqual({ created: [], duplicates: 2, overLimit: 0 });
});

test("a source other than 定期の検査 / エージェント is refused before anything is filed", async () => {
  const b = fakeBacklog();
  await expect(fileRequests([finding(1), { ...finding(2), source: "利用者" as Finding["source"] }], b, "2026-11-01")).rejects.toThrow("source は");
  expect(b.bodies).toHaveLength(0);
});

test("two findings with one title in a run file one request; a backtick run in the detail gets a longer fence", async () => {
  const b = fakeBacklog();
  const r = await fileRequests([finding(1), { ...finding(1), key: "other" }, { ...finding(2), detail: "a\n````\nb" }], b, "2026-11-01");
  expect(r).toEqual({ created: ["#101", "#102"], duplicates: 1, overLimit: 0 });
  expect(b.bodies[1]).toContain("`````text\na\n````\nb\n`````");
});

test("the Issue ops-kit backlog create names: a number, or the localId before GitHub numbers it", () => {
  expect(createdRef("#3801 を作りました（GitHub）\n")).toBe("#3801");
  expect(createdRef("作りました（送信待ち）: localId 3f2a-11。番号が付く前も backlog view 3f2a-11 で読める\n")).toBe("localId 3f2a-11");
});
