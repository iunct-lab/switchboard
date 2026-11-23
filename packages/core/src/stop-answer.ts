import type { Ask, AskAnswer, StopRecord } from "@switchboard/protocol";
import { stopAskId } from "./asks.ts";
import { NEEDS_PERSON, reduceStops, stopKey } from "./stops.ts";

/** The grant a stop shows on its question (as the list gives it): only a stop that waits for the person shows one. */
const shownGrant = (s: { reason: StopRecord["reason"]; grant?: string | null }): string | null => (NEEDS_PERSON.has(s.reason) ? (s.grant ?? null) : null);

/**
 * The one check of an answer to a Task's stop against the stop as its records say it now: which of the Task's stops
 * the answer is an answer to, or null when the question the person saw is no longer the one that stands — nothing is
 * then sent or recorded. Asked when the answer comes in and again right before the grant is recorded and the reply
 * sent (the head of a PR is read in between), with the Task's records read anew each time.
 *
 * `ask` = the question as listed when the answer came in; `answer` = what was sent for it. The grant the person saw is
 * the one the answer carries (`grant`), or for an answer in words the one the listed question showed. It has to be the
 * listed question's grant, and:
 *  - a stop's own question (`stop:`): the series' newest stop still has this id (its op, reason and grant did not move —
 *    the id names the time they took their present form), is not resolved, and shows that same grant. This also tells
 *    apart two grants that came within one millisecond, which share an id. A stop with no grant of its own that
 *    another stop of the Task folded into carries that stop's grant, checked as on a folded question below;
 *  - a question the stop folded into (a check, whose id does not move with the stop): a pressed grant needs a stop that
 *    still asks the person and shows that grant. An answer in words answers all the Task asks, as before.
 * A pressed grant also needs the stop to be still asking (not answered meanwhile).
 * The returned test is `tasks.send`'s `answers`: for a pressed grant the stops of that series (or, folded, of the Task)
 * that say the same grant; for words to a stop's question also the Task's stops that show no grant (the card stood for
 * them). A stop that came or changed while the reply was sent and shows another grant stays open.
 */
export function stopsAnswered(ask: Pick<Ask, "id" | "kind" | "grant">, answer: AskAnswer, records: StopRecord[]): ((s: StopRecord) => boolean) | null {
  const pressed = answer.kind === "grant";
  const seen = answer.kind === "grant" ? answer.grant : ask.grant;
  if (seen !== ask.grant || (pressed && seen === null)) return null;
  const asking = (s: ReturnType<typeof reduceStops>[number]) => s.next === "decide" && !s.answered;
  if (ask.kind === "stop") {
    const all = reduceStops(records);
    const s = all.find((x) => stopAskId(x) === ask.id);
    if (!s || s.state === "resolved") return null;
    const own = (r: StopRecord) => stopKey(r) === s.key && (r.grant ?? null) === s.grant;
    // the card is all the Task asks folded into one (`dedupeAsks`): besides this stop, an answer is to the stops the
    // card stood for — those that show no grant of their own, and the one whose grant the card showed. A stop that
    // shows another grant (it came, or changed, since) was not on the card
    const carded = (r: StopRecord) => own(r) || shownGrant(r) === null || shownGrant(r) === seen;
    if (shownGrant(s) === seen) return pressed ? (asking(s) ? own : null) : carded;
    // the grant on the card is another stop's, folded into this one: as on a check, a stop that still asks has to show
    // it. The press answers the card, this stop with it — the card's id is this stop's, and it is answered once
    if (seen === null || shownGrant(s) !== null || !all.some((x) => asking(x) && shownGrant(x) === seen)) return null;
    return pressed ? (r) => own(r) || shownGrant(r) === seen : carded;
  }
  if (!pressed) return () => true;
  if (!reduceStops(records).some((s) => asking(s) && shownGrant(s) === seen)) return null;
  return (r) => shownGrant(r) === seen;
}
