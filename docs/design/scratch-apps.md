# Scratch apps: a throwaway screen that reads and operates Switchboard

A Task's agent can make a small HTML page on the spot — a board of a PBI's progress, a table of the running Tasks — and
show it in the Task's artifact tab. It is used a few times and thrown away: it is not kept in Git and not tested. It is
registered like any report (`artifacts.md`, the `switchboard-artifact` fence) and opens in the artifact tab, its full
screen and Insights.

## How it reads the API: the bridge

The page runs in a sandboxed frame with an opaque origin (`artifacts.md`, "Safety"), so its own `fetch("/api/…")` is
refused. Instead it asks the screen around it with `postMessage`, and the screen reads the API for it:

- Request (frame → parent): `{ type: "switchboard-api", id, method, path, body? }`.
- Answer (parent → that frame): `{ type: "switchboard-api-result", id, ok, status, body }` — `body` is the API's JSON.
- `method` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`; any other is 405. `path` must start with `/api/`; a path part
  with `..` (also encoded), a backslash, NUL or `//`, a space, a control character or `#` anywhere, a
  path part the browser's URL parser would rewrite (the checks must see the path that is called), a path longer than 2,000 characters, a query with
  `refresh` (it makes the daemon import from GitHub), or a `body` JSON cannot write (a cycle, a BigInt) is 400.
- At most 20 requests per 10 seconds for one open artifact; past that the answer is 429 and nothing is read.
- The screen answers only the frame of the artifact it shows; a message from any other window or frame is ignored.
- Opened on its own (the 新しいタブ button, no screen around it), nothing answers; the client below fails after 3 seconds.

The bridge reads what the Task's agent can already read on localhost; it gives the page no new rights.

## Writes: one confirm per request

A throwaway page is not tested, so a wrong button must not become an operation nobody saw. Every write (`POST`, `PUT`,
`PATCH`, `DELETE`) waits for the person:

- The screen posts `{ type: "switchboard-api-pending", id }` to the frame at once (the client stops its 3-second timer),
  then shows a dialog over the artifact: the artifact's title, the method and path, the body (its first 2,000
  characters), and two buttons, やめる (focused) and 実行する. 実行する takes a press only after 0.5 s, so a click aimed at the
  page under it does not run the operation unread.
- Only 実行する calls the API; the answer is the API's status and JSON as for a read. やめる, Esc, a press outside the
  box, or leaving the artifact (another tab, another artifact) calls nothing and answers `{ ok: false, status: 0, body: { error: "利用者が断った" } }`.
- One dialog at a time: a write that comes while one is open waits until it closes; leaving the artifact declines the
  waiting ones too. There is no "don't ask again" and no
  per-page allow list (a safety confirm is not folded, `ui-layers.md`).
- Refused with 403 without a dialog (the read of the same path is unchanged): a runner's sign-in
  and sign-out (`/api/runners/:id/login…`, `…/logout`), a Task's device sign-in (`/api/tasks/:id/device-auth`), the answer to an approval
  (`/api/tasks/:id/permission`, `/api/asks/answer`) and a Task's permission mode (`/api/tasks/:id/permission-mode`), saved answer policies (`/api/policies…`), the settings
  (`/api/settings`), custom runners (`/api/custom-runners`), a workspace's runner files
  (`/api/workspaces/:id/runner-config`), a view key (`/api/artifacts/:id/view`), and a Task's new MCP token (`/api/tasks/:id/mcp/rotate`). A sign-in or an approval is the
  person's own step on the screen, and a setting or a key outlives the one operation a dialog shows. The table is
  `BRIDGE_REFUSED` in `apps/web/src/scratchBridge.ts`.
- The limit above counts writes too. Undo is each API's own (an artifact's restore, for example).

## Opening a screen

A row on the page (a Task in a queue, for example) can move Switchboard's screen to that Task. The frame has no
`allow-popups` and no `allow-top-navigation`, so a link inside it cannot open a tab or move the page; it asks instead:

- Request (frame → parent): `{ type: "switchboard-navigate", path }`. There is no answer.
- `path` is one of Switchboard's own screens, written as the address bar shows it: `/task/<id>`, or a header tab's
  path (`/`, `/knowledge`, `/ledger`, `/insights`, `/schedules`, `/backlog`, `/resources`, `/approvals`, `/settings`;
  the table is `PATHS` in `apps/web/src/route.ts`). Anything else is dropped without a word: another site
  (`https://…`, `//…`), `/api/…`, `javascript:`, a path that is no screen, a query, a fragment, a %-escape, a `.` or `..`
  segment, a trailing slash or a backslash. The page cannot take the screen outside Switchboard.
- The screen moves without a dialog: it writes nothing (a write still asks, above). The move is a new history entry,
  so the browser's back returns to the screen that showed the artifact (not to the artifact tab itself, which is not
  in the URL).
- As with a read, only the frame of the artifact shown is heard, and the 20-per-10-seconds limit counts these too.
- Opened on its own (the 新しいタブ button), nothing hears the request and nothing happens; the client below sends
  nothing then.

## When a throwaway app keeps being used

A page that is opened again on other days was not throwaway after all. The first request the screen forwards to the API
for a page (a read, or a write the person ran; a refused or declined one is not forwarded) tells the daemon it was used
today (`POST /api/artifacts/:id/app-use`); the daemon counts
each local day once per artifact (`appDays` on the artifact).

- The artifact's row shows 要望にする once its page has used the bridge. It opens the feedback dialog with the draft
  「使い捨てアプリ「<title>」を一般機能にしたい。」 and the artifact as its source (`source: { kind: "artifact", artifactId }`);
  the request's `## 出典` gets the line 「使い捨てアプリから: 成果物 <id>（Task <id>）、写し <folder of the copy>」.
- On the 3rd separate day (`APP_REQUEST_DAYS` in `packages/core/src/artifacts.ts`, not a setting) Switchboard starts
  that request Task itself, once per artifact; its `## 出典` says Switchboard filed it. The row then shows
  要望の Task を始めました with a link to that Task. If the Task cannot start (no meta workspace), the next day that
  counts tries again.
- The request Task reads the page from the copy's folder, which stays as the artifact's copy. A removed artifact is
  not counted and starts no request. Turning the app into a feature is the ordinary request → PBI → Task flow.

## The client: copy these lines into the page

```html
<script>
function sbApi(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { removeEventListener("message", on); reject(new Error("Switchboard の画面の中で開いてください")); }, 3000);
    function on(e) {
      const d = e.data;
      if (e.source !== parent || !d || d.id !== id) return;
      if (d.type === "switchboard-api-pending") return clearTimeout(timer); // a write: the person is asked; wait for them
      if (d.type !== "switchboard-api-result") return;
      clearTimeout(timer); removeEventListener("message", on);
      d.ok ? resolve(d.body) : reject(Object.assign(new Error((d.body && d.body.error) || "HTTP " + d.status), { status: d.status }));
    }
    addEventListener("message", on);
    parent.postMessage({ type: "switchboard-api", id, method, path, body }, "*");
  });
}
function sbOpen(path) {
  if (parent !== window) parent.postMessage({ type: "switchboard-navigate", path }, "*");
}
</script>
```

`sbApi("/api/tasks").then(rows => …)` reads; `sbApi("/api/tasks/" + id + "/abort", "POST")` asks the person first. A
refusal, a failed call, or やめる (status 0, `利用者が断った`) rejects with the status on the error.
`sbOpen("/task/" + id)` moves the screen to that Task (`id` as `/api/tasks` gives it).

## What is worth reading

| Path | What |
|---|---|
| `/api/tasks` | every Task (id, title, status, runner, times) |
| `/api/tasks/:id?limit=0` | one Task without its events |
| `/api/backlog` | the backlog's items and fields |
| `/api/schedules` | the schedules |
| `/api/ops/resources` | the host's memory, disk and load |
| `/api/artifacts?q=&limit=` | artifacts across Tasks |

Read the lists once and again only on a button or every minute or so: `/api/tasks` is large, and the limit above is
there so a throwaway page does not keep the daemon busy. The page cannot listen to `/ws`; read again instead.
