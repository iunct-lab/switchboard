import { describe, expect, test } from "bun:test";
import type { Ask, StopRecord } from "@switchboard/protocol";
import { stopAskId } from "./asks.ts";
import { stopsAnswered } from "./stop-answer.ts";
import { reduceStops } from "./stops.ts";

const [A, B] = ["PR #12 を判定の外でマージしてよい", "PR #13 を判定の外でマージしてよい"];
const rec = (over: Partial<StopRecord> = {}): StopRecord => ({ id: "t1/s1", op: "gh pr merge", target: "PR", reason: "permission", evidence: "refused", safety: "before-effect", state: "waiting", conditions: [], actions: [], grant: A, answer: null, at: 1000, work: { workspaceId: null, issue: null, taskId: "t1" }, ...over }) as StopRecord;
/** The stop's own question as the list gives it for `records`. */
const stopAsk = (records: StopRecord[], grant: string | null = A) => ({ id: stopAskId(reduceStops(records)[0]!), kind: "stop", grant }) as Pick<Ask, "id" | "kind" | "grant">;
const check = (grant: string | null) => ({ id: "check:t1", kind: "check", grant }) as Pick<Ask, "id" | "kind" | "grant">;
const press = (grant: string) => ({ kind: "grant" as const, grant });
const words = { kind: "text" as const, text: "続けて" };

describe("stopsAnswered", () => {
  test("a stop's question: the grant pressed has to be the listed one and the one the stop says now, under the same id", () => {
    const seen = [rec()];
    const ask = stopAsk(seen);
    const answers = stopsAnswered(ask, press(A), seen)!;
    expect(answers).not.toBeNull();
    // the reply answers the stops of that series that say that grant, and no other
    expect([rec(), rec({ id: "t1/s2", grant: B }), rec({ id: "t1/s3", op: "git push" }), rec({ id: "t1/s4" })].map(answers)).toEqual([true, false, false, true]);
    // another sentence than the listed one
    expect(stopsAnswered(ask, press(B), seen)).toBeNull();
    // the stop says another grant now, within the same millisecond (the id is the same): the listed question is not the one that stands
    const moved = [rec(), rec({ grant: B })];
    expect(stopAskId(reduceStops(moved)[0]!)).toBe(ask.id);
    expect(stopsAnswered(ask, press(A), moved)).toBeNull();
    expect(stopsAnswered(ask, words, moved)).toBeNull();
    // reported again later with another grant: another id
    expect(stopsAnswered(ask, press(A), [rec(), rec({ grant: B, at: 2000 })])).toBeNull();
    // resolved, or answered meanwhile: a pressed grant is for a stop that still asks
    expect(stopsAnswered(ask, press(A), [rec(), rec({ state: "resolved", at: 1000 })])).toBeNull();
    expect(stopsAnswered(ask, press(A), [rec(), rec({ answer: { ref: "seq:3", at: 1500 }, at: 1000 })])).toBeNull();
    // no grant listed: nothing to press
    expect(stopsAnswered(stopAsk([rec({ grant: null })], null), press(A), [rec({ grant: null })])).toBeNull();
  });

  test("a stop's question answered in words: the stop still says what the listed question showed", () => {
    const seen = [rec()];
    const answers = stopsAnswered(stopAsk(seen), words, seen)!;
    expect([rec(), rec({ id: "t1/s2", grant: B })].map(answers)).toEqual([true, false]);
    // a stop that shows no grant (the app does not resume it, the person answers in words)
    const waits = [rec({ reason: "depends", grant: null })];
    expect(stopsAnswered(stopAsk(waits, null), words, waits)).not.toBeNull();
  });

  test("a stop's question that carries another stop's grant (folded by the list): the grant and words are still answerable, for the stops they are to", () => {
    // an older permission stop with grant A and a newer stop with no grant of its own, listed as the newer one's question with A on it
    const input = rec({ id: "t1/s2", op: "bun test", reason: "input", grant: null, at: 2000 });
    const seen = [rec(), input];
    const ask = { id: stopAskId(reduceStops(seen).find((s) => s.op === "bun test")!), kind: "stop", grant: A } as Pick<Ask, "id" | "kind" | "grant">;
    // a third stop of the Task with no grant (folded into the card too), and one that shows another grant (not on the card)
    const other = rec({ id: "t1/s4", op: "choose", reason: "decision", grant: null, at: 1500 });
    const later = rec({ id: "t1/s3", op: "git push", grant: B });
    // the pressed grant answers the stop that says it and the stop the card is (its id is answered once); words answer all the card stood for
    expect([rec(), input, other, later].map(stopsAnswered(ask, press(A), seen)!)).toEqual([true, true, false, false]);
    expect([rec(), input, other, later].map(stopsAnswered(ask, words, seen)!)).toEqual([true, true, true, false]);
    // words to a stop's own question (nothing folded) answer the Task's other stops without a grant too, as a reply did before
    expect([input, other, later].map(stopsAnswered({ ...ask, grant: null }, words, [input])!)).toEqual([true, true, false]);
    // the folded stop says another grant now, or was resolved: the question the person saw does not stand
    expect(stopsAnswered(ask, press(A), [rec(), input, rec({ grant: B, at: 3000 })])).toBeNull();
    expect(stopsAnswered(ask, words, [rec(), input, rec({ state: "resolved", at: 3000 })])).toBeNull();
    // a sentence the card did not show
    expect(stopsAnswered(ask, press(B), seen)).toBeNull();
  });

  test("a grant folded into a check: a stop that still asks has to say the grant pressed, and the reply answers the stops that say it", () => {
    const answers = stopsAnswered(check(A), press(A), [rec()])!;
    expect([rec(), rec({ id: "t1/s2", grant: B }), rec({ id: "t1/s3", reason: "transient" })].map(answers)).toEqual([true, false, false]);
    // the stop says another grant now: the check's id did not move, the grant did
    expect(stopsAnswered(check(A), press(A), [rec(), rec({ grant: B, at: 2000 })])).toBeNull();
    // a grant some other stop of the Task says, which the card did not show
    expect(stopsAnswered(check(A), press(B), [rec(), rec({ id: "t1/s2", op: "git push", grant: B })])).toBeNull();
    // the stop was answered or resolved meanwhile
    expect(stopsAnswered(check(A), press(A), [rec(), rec({ state: "resolved", at: 2000 })])).toBeNull();
    // an answer in words to the check answers all the Task asks, as before
    expect([rec(), rec({ grant: B })].map(stopsAnswered(check(A), words, [rec()])!)).toEqual([true, true]);
  });
});
