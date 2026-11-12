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
- A feature that does not work in the current setup (one instance on a remote host such as EC2, the browser on a different device) or that is unused may be removed, but only when the user decides so for that candidate. The agent never removes one on its own judgment. This is separate from the rule above: removing a feature to lower the floor stays forbidden.

## How a backlog item states it

A backlog item (PBI) that changes how the web UI looks or is operated carries one line, after its prerequisites line (and after the screen-image line when it has one):

```markdown
**置き場所**: 床|天井|壁 — <reason>
```

The labels are Japanese because the backlog is written in Japanese (`床` = floor, `天井` = ceiling, `壁` = walls). Items that do not change the screen do not carry the line. Nothing checks the line automatically; missing lines are found by periodic review rather than by a lint, until it is clear the line is being used.

## Relation to the UI language rule

`ui-language.md` says not to add explanatory text to a screen and to send rarely used operations to Settings. That rule limits how much text a screen carries; this document decides where a feature is placed. They do not conflict: a feature placed on the ceiling still follows the text limit, and a lower floor is never reached by adding text that explains the floor.
