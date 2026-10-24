// Switchboard's service worker (#26): only the app shell is cached, so the PWA opens without the network. The API,
// the event socket and MCP are never touched — approvals must always be live, and an answer must reach the daemon.
const CACHE = "switchboard-shell-v1";
// /_auth (the login on the Starter Lambda), /_start (the page CloudFront shows while the machine is stopped) and
// /rescue are not the app: never answered from here (#211). /artifacts is a registered report (#1777): a page of it opened in a tab
// must not be kept as the app shell.
const LIVE = /^\/(api|ws|mcp|artifacts|_auth|_start|rescue)(\/|$)/;

// The shell and the hashed bundles it names, so the first offline launch after installing already has the app.
async function precache() {
  const c = await caches.open(CACHE);
  await c.addAll(["/", "/manifest.webmanifest", "/icons/icon-192.png"]);
  const html = await (await c.match("/")).text();
  await c.addAll([...new Set(html.match(/\/assets\/[^"']+/g) ?? [])]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || LIVE.test(url.pathname)) return;
  if (event.request.mode === "navigate") {
    // Network first: a new build shows at once. Only a real page becomes the shell. A page the server sent with an
    // error status is shown as it is and not kept: on the cloud host that is the "stopped" page that leads to the login
    // and 起動する (#211), which the cached shell must not hide. Offline (no answer at all), the cached shell.
    const shell = (r) => caches.match("/").then((hit) => hit ?? r);
    event.respondWith(
      fetch(event.request)
        .then((r) => {
          const html = (r.headers.get("content-type") ?? "").includes("text/html");
          if (!r.ok) return html ? r : shell(r);
          if (!html) return shell(r);
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return r;
        })
        .catch(() => shell(undefined)),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Hashed build files never change under the same name: cache first.
    event.respondWith(caches.match(event.request).then((hit) => hit ?? fetch(event.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); } return r; })));
    return;
  }
  if (url.pathname.startsWith("/icons/")) {
    // Not hashed: answer from the cache, refresh it behind, so a redrawn icon arrives on the next open.
    const fresh = fetch(event.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); } return r; });
    event.respondWith(caches.match(event.request).then((hit) => hit ?? fresh));
    event.waitUntil(fresh.catch(() => undefined));
  }
});
