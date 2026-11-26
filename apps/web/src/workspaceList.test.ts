import { describe, expect, test } from "bun:test";
import type { Workspace } from "@switchboard/protocol";
import { shownWorkspaces } from "./workspaceList.ts";

const ws = (id: string, kind: Workspace["kind"]) => ({ id, kind, name: id, path: `/p/${id}` }) as Workspace;
const all = [ws("self", "meta"), ws("a", "repo"), ws("b", "repo")];

describe("shownWorkspaces", () => {
  test("release-only hides the meta row", () => {
    expect(shownWorkspaces(all, true).map((w) => w.id)).toEqual(["a", "b"]);
  });
  test("a clone keeps the meta row", () => {
    expect(shownWorkspaces(all, false).map((w) => w.id)).toEqual(["self", "a", "b"]);
  });
});
