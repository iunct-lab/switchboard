import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Workspace } from "@switchboard/protocol";
import { WorkspaceCard } from "./components/WorkspaceCard.tsx";
import { api, type WorkspaceClone } from "./api.ts";

const ws = { id: "w1", name: "app", path: "/srv/app", kind: "repo" } as Workspace;
const html = (clones: WorkspaceClone[]) =>
  renderToStaticMarkup(createElement(WorkspaceCard, { workspaces: [ws], clones, onAddWorkspaceFromGithub: async () => undefined, onAddWorkspace: async () => undefined, onTaskStarted: () => undefined, onError: () => undefined }));

test("WorkspaceCard: GitHub から is the first and default method, the host-path method keeps its own button (#2575)", () => {
  const h = html([]);
  expect(h.indexOf("GitHub から")).toBeLessThan(h.indexOf("新しく作る"));
  expect(h).toContain("owner/name か https://github.com/owner/name");
  expect(h).toContain("ホストにあるディレクトリを追加</button>");
  expect(h).toContain("GitHub と連携しない");
  expect(h).toContain("/srv/app");
});

test("WorkspaceCard: a clone going on and a failed one show their rows", () => {
  const h = html([
    { repo: "acme/app", path: "/srv/app2", state: "cloning" },
    { repo: "acme/gone", path: "/srv/gone", state: "failed", error: "fatal: repository not found" },
  ]);
  expect(h).toContain("acme/app を /srv/app2 に clone しています");
  expect(h).toContain("acme/gone を追加できませんでした: fatal: repository not found");
  expect(html([])).not.toContain("clone しています");
});

test("WorkspaceCard: the mark to create your own private repository is always offered, unchecked, under the GitHub から field", () => {
  const h = html([]);
  expect(h).toContain("自分の GitHub に非公開のリポジトリを作る");
  expect(h.indexOf("自分の GitHub に非公開のリポジトリを作る")).toBeGreaterThan(h.indexOf("owner/name か https://github.com/owner/name"));
  expect(h).not.toMatch(/checked[^>]*>\s*自分の GitHub/);
  const going = html([{ repo: "acme/app", path: "/srv/app2", state: "cloning" }]);
  expect(going.indexOf("自分の GitHub に非公開のリポジトリを作る")).toBeLessThan(going.indexOf("acme/app を /srv/app2 に clone しています"));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("api.addWorkspaceFromGithub sends ownCopy when asked, false otherwise", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await api.addWorkspaceFromGithub("someone/widget", "github", true);
  await api.addWorkspaceFromGithub("me/app", "switchboard");
  expect(bodies).toEqual([{ repo: "someone/widget", backlog: "github", ownCopy: true }, { repo: "me/app", backlog: "switchboard", ownCopy: false }]);
});
