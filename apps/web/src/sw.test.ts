import { expect, test } from "bun:test";

// The service worker (#26) on the cloud host (#211): the login and the "stopped" page are not the app, and a page the
// server sends with an error status (CloudFront's stopped page, 503) is shown rather than hidden behind the cached shell.
const sw = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();

test("the service worker leaves /_auth, /_start and /rescue alone and shows a server's error page as it is", () => {
  const live = new RegExp(sw.match(/const LIVE = \/(.+)\/;/)![1]!);
  for (const p of ["/_auth/", "/_auth", "/_start/index.html", "/rescue/", "/api/health", "/ws", "/artifacts/k/index.html"]) expect(live.test(p), p).toBe(true);
  for (const p of ["/", "/approvals", "/assets/x.js"]) expect(live.test(p), p).toBe(false);
  expect(sw).toContain("if (!r.ok) return html ? r : shell(r);");
});
