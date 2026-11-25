# UI layers: floor, ceiling, walls

Where a feature goes on the screen is decided before the work is planned, not after the screen has grown. Switchboard reads the three principles of "low floor, high ceiling, wide walls" (a framing from the design of creative tools for learners) as three places a feature can live, and every backlog item that changes how the web UI looks or is operated names one of them. The owner asked for this on 2026-10-31 as a rule that is applied every time, not as a one-off cleanup: the first screen kept collecting values that are not touched on every request.

## The three layers

| Layer | Promise | Where it lives | Examples |
|---|---|---|---|
| Floor | Someone in a hurry, or trying Switchboard for the first time, asks for work with the fewest steps | The first screen (Home) and the one action each screen exists for | Typing a request and starting it; approving a waiting operation |
| Ceiling | The person running Switchboard can tune how it runs, in as much detail as they need | Settings, and folded sections that open on demand | Run location, model choice, schedules, repository registration |
| Walls | The screens and routes reach many different ways of using it | Separate screens, links and entry points that do not crowd the floor | Opening a screen from a link, the phone layout, the Ledger and the Backlog |

A feature belongs to the layer whose promise it serves. Adding to the ceiling or the walls must not make the floor heavier.

## Reading it with one user

The original framing is about different people: beginners want a low floor, experts a high ceiling. Switchboard has one user (the owner), so the layers are read as different moments of the same person, plus one other person:

- The same person in different situations: asking for work in a hurry (floor), approving from a phone (floor and walls), tuning the runners and the backlog (ceiling).
- Someone trying the public repository for the first time: they meet only the floor, and they should be able to ask for a first task without reading Settings.

## What is folded and what is not

- Values that are not touched on every request are folded or moved to Settings. A proposal that places such a value on the floor (Home, or the main action of a screen) either moves it to the ceiling or states why it must stay on the floor.
- Confirmations that protect safety are never folded: approvals, the permission mode, and warnings before an operation that cannot be undone stay where the decision is made.
- No feature is removed for the sake of a lower floor. Only where it is shown changes; what can be done stays the same.
- A feature that does not work in the current setup (one instance on a remote machine such as EC2, the browser on a different device) or that is unused may be removed, but only when the user decides so for that candidate. The agent never removes one on its own judgment. This is separate from the rule above: removing a feature to lower the floor stays forbidden.

## How a backlog item states it

A backlog item (PBI) that changes how the web UI looks or is operated carries one line, after its prerequisites line (and after the screen-image line when it has one):

```markdown
**置き場所**: 床|天井|壁 — <reason>
```

The labels are Japanese because the backlog is written in Japanese (`床` = floor, `天井` = ceiling, `壁` = walls). Items that do not change the screen do not carry the line. Nothing checks the line automatically; missing lines are found by periodic review rather than by a lint, until it is clear the line is being used.

## The monthly check

A prompt schedule (`（サンプル）床・天井・壁の点検` in Schedules: one of the schedule samples of `packages/core/src/scheduleSamples.ts`, put in once at first start, disabled until the person turns it on; its cron, runner and prompt are what Schedules shows and can change) starts one Task that checks the screens against this document. The schedule's prompt only points here; these are the steps. Work in the repository root, and keep the working files under `W=$(mktemp -d /tmp/switchboard.ui-layers.XXXXXX)`.

1. Count the measures: `bun scripts/ui-layers-metrics.ts > "$W/metrics.json"`.
2. Name the screen backlog items that have no placement line: `bun scripts/ui-layers-placement.ts --days 30 > "$W/placement.json"`. If it exits 2, write the reason into the rating sentences of the report and continue with `{"checked":0,"missing":[]}`.
3. Write the ratings: read this document, the values from step 1, the previous values (the last line of `${SWITCHBOARD_HOME:-$HOME/.switchboard}/ui-layers/history.jsonl`; none means the first check), and what the screen code (`apps/web/src`) shows. Write 2 to 4 sentences each for the floor, the ceiling and the walls, as `{"floor":"…","ceiling":"…","walls":"…"}` in `"$W/ratings.json"`.
4. Make the report: `bun scripts/ui-layers-report.ts --metrics "$W/metrics.json" --placement "$W/placement.json" --ratings "$W/ratings.json" --out "$W/ui-layers.html"`. Every run appends one line to the history, so run it once per check. To make it again, copy the history into `"$W"`, drop its last line (this check's), and pass that copy with `--history`. Register the HTML as an artifact with a `switchboard-artifact` fence in the reply, titled `床・天井・壁の点検 YYYY-MM-DD`.
5. File requests: only what got worse than last time and what is newly found, as a findings JSON (`[{"key","title","detail","source"}]`, at most 3, most important first; `source` is `定期の検査` for a change in the measures and `エージェント` for something read in the code), with `bun scripts/ui-layers-requests.ts --findings "$W/findings.json"`. Run nothing here when there is none.

A worse measure stops nothing: do not merge, release, fix a screen or create a backlog item. End the reply with the numbers of the requests filed (`なし` when none) and a three-line summary of the ratings.

## Relation to the UI language rule

`ui-language.md` says not to add explanatory text to a screen and to send rarely used operations to Settings. That rule limits how much text a screen carries; this document decides where a feature is placed. They do not conflict: a feature placed on the ceiling still follows the text limit, and a lower floor is never reached by adding text that explains the floor.
