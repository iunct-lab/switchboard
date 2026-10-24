import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { fakeGh, type FakeCall } from "./gh.ts";
import { createRequest } from "./request.ts";
import { UsageError } from "./set.ts";

const cfg = loadConfig(join(import.meta.dir, "../fixtures/config-with-phase.json"));
let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-kit-request-"));
  saved = process.env.GH_REPO;
  process.env.GH_REPO = "example/repo";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = saved;
});

describe("request", () => {
  test("creates the type:request Issue from the body file, then sets Status Backlog", async () => {
    const body = join(dir, "req.md");
    writeFileSync(body, "## 要望\n整えた文\n\n## 出典\n- 誰の言葉: 利用者\n- いつ: 2026-01-01\n- 経路: チャット\n");
    const gh = fakeGh([
      () => "https://github.com/example/repo/issues/42\n",
      () => ({ repositoryOwner: { projectV2: { id: "P1", field: { id: "F", dataType: "SINGLE_SELECT", options: [{ id: "B", name: "Backlog" }] } } }, repository: { issue: { id: "I42", projectItems: { nodes: [] } } } }),
      () => ({ addProjectV2ItemById: { item: { id: "IT" } } }),
      () => ({}),
    ]);
    const log: string[] = [];
    expect(await createRequest(gh, cfg, { title: "要望: 例", bodyFile: body }, (s) => log.push(s))).toBe(42);
    expect(gh.calls[0]).toEqual({ kind: "run", args: ["issue", "create", "-R", "example/repo", "-t", "要望: 例", "-l", "type:request", "-F", body] });
    expect((gh.calls[1] as Extract<FakeCall, { kind: "graphql" }>).vars).toMatchObject({ f: "Status", n: 42 });
    expect((gh.calls[3] as Extract<FakeCall, { kind: "graphql" }>).vars).toMatchObject({ i: "IT", value: "B" });
    expect(log).toEqual([">> 要望を作成: #42 https://github.com/example/repo/issues/42", ">> Project に追加: #42", "#42  Status = Backlog"]);
  });

  test("a body without the required sections is refused and nothing is created", async () => {
    const body = join(dir, "req.md");
    writeFileSync(body, "## 要望\n整えた文だけ\n");
    const gh = fakeGh([]);
    const p = createRequest(gh, cfg, { title: "要望: 例", bodyFile: body }, () => undefined);
    await expect(p).rejects.toThrow("要望の本文に ## 出典 が無いので作りません");
    await expect(p).rejects.toBeInstanceOf(UsageError);
    expect(gh.calls).toHaveLength(0);
    await expect(createRequest(gh, cfg, { title: "x", bodyFile: join(dir, "none.md") }, () => undefined)).rejects.toThrow(/本文のファイルを読めません/);
  });

  test("request: a body without 誰の言葉 is refused before anything is created (誰の言葉)", async () => {
    const body = join(dir, "req.md");
    writeFileSync(body, "## 要望\n整えた文\n\n## 出典\n- 誰から: 利用者\n");
    const gh = fakeGh([]);
    const p = createRequest(gh, cfg, { title: "要望: 例", bodyFile: body }, () => undefined);
    await expect(p).rejects.toThrow("要望の「## 出典」に「- 誰の言葉: 利用者 / エージェント / 定期の検査」の行が無いので作りません。利用者の文を引けなければ エージェント");
    await expect(p).rejects.toBeInstanceOf(UsageError);
    expect(gh.calls).toHaveLength(0);
  });

  test("when setting Status fails after the Issue exists, the error says how to go on without filing it twice", async () => {
    const body = join(dir, "req.md");
    writeFileSync(body, "## 要望\nx\n\n## 出典\n- 誰の言葉: エージェント\n");
    const gh = fakeGh([() => "https://github.com/example/repo/issues/7\n", () => { throw new Error("gh: missing project scope"); }]);
    await expect(createRequest(gh, cfg, { title: "要望: 例", bodyFile: body }, () => undefined)).rejects.toThrow("gh: missing project scope\n要望 #7 は作成済みです。request をやり直さず、set 7 Status Backlog で続けてください");
  });
});
