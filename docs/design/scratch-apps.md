# Scratch apps: a throwaway screen that reads Switchboard

A Task's agent can make a small HTML page on the spot — a board of a PBI's progress, a table of the running Tasks — and
show it in the Task's artifact tab. It is used a few times and thrown away: it is not kept in Git and not tested. It is
registered like any report (`artifacts.md`, the `switchboard-artifact` fence) and opens in the artifact tab, its full
screen and Insights.

## How it reads the API: the bridge

The page runs in a sandboxed frame with an opaque origin (`artifacts.md`, "Safety"), so its own `fetch("/api/…")` is
refused. Instead it asks the screen around it with `postMessage`, and the screen reads the API for it:

- Request (frame → parent): `{ type: "switchboard-api", id, method: "GET", path }`.
- Answer (parent → that frame): `{ type: "switchboard-api-result", id, ok, status, body }` — `body` is the API's JSON.
- Reading only: a method other than `GET` is 405. `path` must start with `/api/`; a path part with `..` (also encoded),
  a backslash, NUL or `//`, a path longer than 2,000 characters, or a query with `refresh` (it makes the daemon import
  from GitHub) is 400.
- At most 20 requests per 10 seconds for one open artifact; past that the answer is 429 and nothing is read.
- The screen answers only the frame of the artifact it shows; a message from any other window or frame is ignored.
- Opened on its own (the 新しいタブ button, no screen around it), nothing answers; the client below fails after 3 seconds.

The bridge reads what the Task's agent can already read on localhost; it gives the page no new rights.

## The client: copy these lines into the page

```html
<script>
function sbApi(path) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { removeEventListener("message", on); reject(new Error("Switchboard の画面の中で開いてください")); }, 3000);
    function on(e) {
      const d = e.data;
      if (e.source !== parent || !d || d.type !== "switchboard-api-result" || d.id !== id) return;
      clearTimeout(timer); removeEventListener("message", on);
      d.ok ? resolve(d.body) : reject(Object.assign(new Error((d.body && d.body.error) || "HTTP " + d.status), { status: d.status }));
    }
    addEventListener("message", on);
    parent.postMessage({ type: "switchboard-api", id, method: "GET", path }, "*");
  });
}
</script>
```

`sbApi("/api/tasks").then(rows => …)`; a refusal or a failed read rejects with the status on the error.

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
