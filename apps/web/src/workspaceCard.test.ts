import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Workspace } from "@switchboard/protocol";
import { OwnCopyFields, WorkspaceCard } from "./components/WorkspaceCard.tsx";
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

const fields = (ownCopy: boolean, owner: string, repo: string) =>
  renderToStaticMarkup(createElement(OwnCopyFields, { ownCopy, owner, repo, onOwnCopy: () => undefined, onOwner: () => undefined }));

test("OwnCopyFields: the destination field is only there while the mark is on, after the mark", () => {
  const off = fields(false, "", "someone/widget");
  expect(off).toContain("自分の GitHub に非公開のリポジトリを作る");
  expect(off).not.toContain("作り先");
  expect(off).not.toContain("→");
  const on = fields(true, "", "someone/widget");
  expect(on).toContain('aria-label="作り先"');
  expect(on.indexOf('aria-label="作り先"')).toBeGreaterThan(on.indexOf("自分の GitHub に非公開のリポジトリを作る"));
});

test("OwnCopyFields: shows <owner>/<name> from the repo input, my account when the owner is empty", () => {
  expect(fields(true, "my-org", "https://github.com/someone/widget.git")).toContain("→ my-org/widget");
  expect(fields(true, "", "someone/widget/")).toContain("→ 自分のアカウント/widget");
  expect(fields(true, " my-org ", "someone/widget")).toContain("→ my-org/widget");
  expect(fields(true, "my-org", "")).toContain("→ my-org/&lt;名前&gt;");
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

test("api.addWorkspaceFromGithub sends ownCopyOwner only with the mark and a non-empty owner", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await api.addWorkspaceFromGithub("someone/widget", "github", true, " my-org ");
  await api.addWorkspaceFromGithub("someone/widget", "github", true, "  ");
  await api.addWorkspaceFromGithub("someone/widget", "github", false, "my-org");
  expect(bodies).toEqual([
    { repo: "someone/widget", backlog: "github", ownCopy: true, ownCopyOwner: "my-org" },
    { repo: "someone/widget", backlog: "github", ownCopy: true },
    { repo: "someone/widget", backlog: "github", ownCopy: false },
  ]);
});
