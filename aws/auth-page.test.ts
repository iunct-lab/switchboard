import { describe, expect, test } from "bun:test";

/** The start page's recovery paths (aws/auth-page.html, #1394), run with a fake clock, api, sleep and elements. */
const page = await Bun.file(new URL("./auth-page.html", import.meta.url)).text();
const between = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to));
const src = [between("async function waitForDaemon", "const FORCE_AFTER_MS"), between("const FORCE_AFTER_MS", "const START_WAIT_MS")].join("\n");

function run(o: { states: string[]; daemonAt?: number; rescue?: boolean; confirmed?: boolean; stay?: string }) {
  let now = 0;
  let asked = 0;
  const said: string[] = [];
  const shown: Array<{ at: number; ids: string[] }> = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const children: unknown[][] = [];
  const els: Record<string, { disabled: boolean; replaceChildren: (...c: unknown[]) => void }> = {};
  const $ = (id: string) => (els[id] ??= { disabled: false, replaceChildren: (...c) => void children.push(c) });
  const disabledWhenShown: boolean[] = [];
  const api = async (path: string, body?: unknown) => {
    if (body !== undefined) return void posts.push({ path, body });
    return { state: o.states[Math.min(asked++, o.states.length - 1)] };
  };
  const env = {
    api,
    daemonUp: async () => o.daemonAt !== undefined && now >= o.daemonAt,
    rescueUp: async () => o.rescue ?? false,
    sleep: async (ms: number) => void (now += ms),
    say: (t: string) => void said.push(t),
    show: (...ids: string[]) => {
      shown.push({ at: now, ids });
      if (ids.includes("forceStop")) disabledWhenShown.push($("forceStop").disabled);
    },
    $,
    confirm: () => o.confirmed ?? true,
    withRecent: (send: () => unknown) => send(),
    Date: { now: () => now },
    location: { replace: (u: string) => void said.push(`go ${u}`) },
    back: () => "/",
    stays: () => o.stay ?? "",
    document: { createElement: () => ({}) },
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${src}\nreturn { waitForDaemon, waitForStop, stop };`)(...names.map((n) => (env as Record<string, unknown>)[n])) as {
    waitForDaemon: (t?: number) => Promise<void>;
    waitForStop: (t?: number) => Promise<void>;
    stop: (force: boolean) => Promise<void>;
  };
  return { fns, said, shown, posts, children, disabledWhenShown };
}

describe("aws/auth-page.html recovery (#1394)", () => {
  test("running and not answering shows stop and 作り直す at 0 s, with the boot note", async () => {
    const t = run({ states: ["running"], daemonAt: 9000 });
    await t.fns.waitForDaemon(0);
    const first = t.shown.find((s) => s.ids.includes("stop"))!;
    expect(first.at).toBe(0);
    expect(first.ids).toEqual(expect.arrayContaining(["stop", "rebuild", "rescue"]));
    expect(t.said[0]).toContain("起動の途中なら 20〜30 秒で開きます");
    expect(t.said.at(-1)).toBe("go /"); // and it still goes in once the daemon answers
  });

  test("the rescue note says whether the rescue page answers", async () => {
    const up = run({ states: ["running"], daemonAt: 3000, rescue: true });
    await up.fns.waitForDaemon(0);
    expect(up.children[0]!.some((c) => (c as { href?: string }).href === "/rescue/")).toBe(true);
    const down = run({ states: ["running"], daemonAt: 3000, rescue: false });
    await down.fns.waitForDaemon(0);
    expect(down.children[0]).toEqual(["救援画面も応答しません。停止か作り直すを使ってください。"]);
  });

  test("a machine that is not running offers no stop while it boots", async () => {
    const t = run({ states: ["pending"], daemonAt: 3000 });
    await t.fns.waitForDaemon(0);
    expect(t.shown.some((s) => s.ids.includes("stop"))).toBe(false);
  });

  test("stop waits for stopped and then offers 起動する", async () => {
    const t = run({ states: ["stopping", "stopping", "stopped"] });
    await t.fns.stop(false);
    expect(t.posts).toEqual([{ path: "stop", body: { force: false } }]);
    expect(t.shown.at(-1)!.ids).toEqual(["start", "logout"]);
    expect(t.said.at(-1)).toContain("機械は止まっています");
  });

  test("still stopping after 2 minutes offers 強制停止, which sends force: true", async () => {
    const states = [...Array(50).fill("stopping"), "stopped"];
    const t = run({ states });
    await t.fns.stop(false);
    const force = t.shown.find((s) => s.ids.includes("forceStop"))!;
    expect(force.at).toBeGreaterThanOrEqual(120_000);
    expect(t.disabledWhenShown.every((d) => d === false)).toBe(true); // pressable when it appears
    expect(t.shown.filter((s) => s.at < 120_000).some((s) => s.ids.includes("forceStop"))).toBe(false);
    const forced = run({ states: ["stopped"] });
    await forced.fns.stop(true);
    expect(forced.posts).toEqual([{ path: "stop", body: { force: true } }]);
  });

  test("a machine that goes stopping while the page waits for the daemon moves to the stop wait", async () => {
    const t = run({ states: ["running", "stopping", "stopped"] });
    await t.fns.waitForDaemon(0);
    expect(t.shown.at(-1)!.ids).toEqual(["start", "logout"]);
  });

  test("a machine that runs again during the stop wait goes back to waiting for the daemon", async () => {
    const t = run({ states: ["stopping", "running"], daemonAt: 6000 });
    await t.fns.waitForStop(0);
    expect(t.said.at(-1)).toBe("go /");
  });

  test("declining the confirmation sends nothing", async () => {
    const t = run({ states: ["running"], confirmed: false });
    await t.fns.stop(true);
    expect(t.posts).toEqual([]);
  });
});

describe("aws/auth-page.html countries (#1639)", () => {
  const src = between("function countriesBody", "async function render");
  /** The section's functions with fake elements, api and withRecent. */
  function env(o: { view: unknown; saved?: unknown }) {
    const els: Record<string, { hidden: boolean; textContent: string; value: string; disabled: boolean }> = {};
    const $ = (id: string) => (els[id] ??= { hidden: true, textContent: "", value: "", disabled: false });
    const posts: Array<{ path: string; body: unknown }> = [];
    const rechecked: boolean[] = [];
    const api = async (path: string, body?: unknown) => {
      if (body !== undefined) posts.push({ path, body });
      return body === undefined ? o.view : (o.saved ?? o.view);
    };
    const say = () => {};
    const withRecent = (send: () => unknown) => (rechecked.push(true), send());
    const fns = new Function("$", "api", "say", "withRecent", `${src}\nreturn { countriesBody, countriesText, loadCountries, saveCountries };`)($, api, say, withRecent) as {
      countriesBody: (t: string, f: string, u: string) => { countries: string[]; from?: number; until?: number };
      countriesText: (v: unknown) => string;
      loadCountries: () => Promise<void>;
      saveCountries: () => Promise<void>;
    };
    return { $, posts, rechecked, ...fns };
  }
  const view = (base: string[], allowance: unknown = null, active = false) => ({ base, allowance, active });

  test("a logged-in person sees the section; an empty base says there is no restriction and offers no form", async () => {
    const t = env({ view: view(["JP"], { countries: ["US"], from: 0, until: 86400_000, setAt: 0 }, true) });
    await t.loadCountries();
    expect(t.$("countries").hidden).toBe(false);
    expect(t.$("cState").textContent).toContain("常時: JP");
    expect(t.$("cState").textContent).toContain("追加: US");
    expect(t.$("cState").textContent).toContain("期間中");
    expect(t.$("cForm").hidden).toBe(false);
    const open = env({ view: view([]) });
    await open.loadCountries();
    expect(open.$("cState").textContent).toBe("国の制限はありません");
    expect(open.$("cForm").hidden).toBe(true);
  });

  test("save goes through withRecent and sends the countries upper-cased with epoch milliseconds", async () => {
    const t = env({ view: view(["JP"]) });
    t.$("cCountries").value = "us, gb";
    t.$("cFrom").value = "2026-11-01T09:00";
    t.$("cUntil").value = "2026-11-10T09:00";
    await t.saveCountries();
    expect(t.rechecked).toEqual([true]);
    const body = t.posts[0]!.body as { countries: string[]; from: number; until: number };
    expect(t.posts[0]!.path).toBe("countries");
    expect(body.countries).toEqual(["US", "GB"]);
    expect(body.from).toBe(new Date("2026-11-01T09:00").getTime());
    expect(body.until).toBe(new Date("2026-11-10T09:00").getTime());
  });

  test("the section is in the page, hidden until a login", () => {
    expect(page).toContain('<div class="card" id="countries" hidden>');
    expect(page).toContain('location.hash === "#countries"');
  });
});

describe("aws/auth-page.html passkeys (#414)", () => {
  const src = [between("/** One row of the passkey list", "async function render"), between("const pad = ", "/** The state line")].join("\n");
  type El = { hidden: boolean; textContent: string; disabled: boolean; className: string; onclick?: () => unknown; children: El[]; replaceChildren: (...c: El[]) => void; append: (...c: El[]) => void };
  const el = (): El => {
    const e: El = { hidden: true, textContent: "", disabled: false, className: "", children: [], replaceChildren: (...c) => void (e.children = c), append: (...c) => void e.children.push(...c) };
    return e;
  };
  /** The section's functions with fake elements, api, assertFresh and confirm; `order` is every check and call in turn. */
  function env(o: { list: unknown[]; fresh?: boolean; confirmed?: boolean; fail?: Record<string, Error> }) {
    const els: Record<string, El> = {};
    const $ = (id: string) => (els[id] ??= el());
    const order: string[] = [];
    const said: Array<[string, boolean | undefined]> = [];
    const api = async (path: string, body?: unknown) => {
      order.push(body === undefined ? `GET ${path}` : `POST ${path} ${JSON.stringify(body)}`);
      if (o.fail?.[path]) throw o.fail[path];
      if (path === "passkeys") return { passkeys: o.list };
      if (path === "device-code") return { code: "CODE", expires: new Date(2026, 9, 24, 9, 30).getTime() };
      return { ok: true };
    };
    const assertFresh = async () => (order.push("credentials.get"), o.fresh === false ? null : { rpId: "sb.example", signed: { challenge: "c", id: "k" } });
    const confirm = (text: string) => (order.push(`confirm ${text}`), o.confirmed ?? true);
    const rendered: unknown[] = [];
    const names = ["$", "api", "assertFresh", "confirm", "say", "render", "document", "location", "navigator"];
    const values = [$, api, assertFresh, confirm, (t: string, bad?: boolean) => void said.push([t, bad]), async (n: unknown) => void rendered.push(n), { createElement: el }, { origin: "https://sb.example" }, { clipboard: { writeText: async (t: string) => void order.push(`copy ${t}`) } }];
    const fns = new Function(...names, `${src}\nreturn { loadDevices, addDevice, removePasskey, copyLink };`)(...values) as {
      loadDevices: () => Promise<void>;
      addDevice: () => Promise<void>;
      removePasskey: (p: unknown) => Promise<void>;
      copyLink: () => Promise<void>;
    };
    return { $, order, said, rendered, ...fns };
  }
  const a = { id: "A", device: "iPhone / iPad", created: new Date(2026, 8, 27, 10, 5).getTime(), lastUsed: new Date(2026, 9, 24, 8, 0).getTime(), current: true };
  const b = { id: "B", device: "Mac", created: new Date(2026, 9, 1, 12, 0).getTime(), lastUsed: null, current: false };

  test("the list shows device, registered, last used (— when never) and this browser's mark, each with 削除", async () => {
    const t = env({ list: [a, b] });
    await t.loadDevices();
    expect(t.$("devices").hidden).toBe(false);
    const rows = t.$("passkeys").children.map((li) => li.children.map((c) => c.textContent));
    expect(rows).toEqual([
      ["iPhone / iPad（この端末）", "登録 2026-09-27 10:05 / 最後に使った 2026-10-24 08:00", "削除"],
      ["Mac", "登録 2026-10-01 12:00 / 最後に使った —", "削除"],
    ]);
    const failing = env({ list: [], fail: { passkeys: new Error("401") } });
    await failing.loadDevices();
    expect(failing.$("devices").hidden).toBe(true);
  });

  test("別の端末を追加 checks the passkey, then shows the one-time link and its expiry, and copies it", async () => {
    const t = env({ list: [a] });
    await t.addDevice();
    expect(t.order).toEqual(["credentials.get", 'POST device-code {"challenge":"c","id":"k"}', "GET passkeys"]);
    expect(t.$("deviceLink").hidden).toBe(false);
    expect(t.$("deviceUrl").textContent).toBe("https://sb.example/_auth/#register=CODE");
    expect(t.$("deviceExpires").textContent).toBe("2026-10-24 09:30");
    await t.copyLink();
    expect(t.order.at(-1)).toBe("copy https://sb.example/_auth/#register=CODE");
    // cancelled: nothing is asked for; 5 passkeys: the Starter's sentence, as an error
    const cancelled = env({ list: [a], fresh: false });
    await cancelled.addDevice();
    expect(cancelled.order).toEqual(["credentials.get"]);
    const full = env({ list: [a], fail: { "device-code": new Error("パスキーは 5 本までです。使っていないものを消してから追加してください") } });
    await full.addDevice();
    expect(full.said.at(-1)).toEqual(["パスキーは 5 本までです。使っていないものを消してから追加してください", true]);
    expect(full.$("deviceLink").hidden).toBe(true);
  });

  test("削除 asks first, checks the passkey, deletes and redraws; declining sends nothing; the last one shows the Starter's 409", async () => {
    const t = env({ list: [a] });
    await t.removePasskey(b);
    expect(t.order[0]).toBe("confirm Mac（登録 2026-10-01 12:00）のパスキーを消します。その端末ではログインできなくなります。進めますか？");
    expect(t.order.slice(1)).toEqual(["credentials.get", 'POST passkeys/delete {"target":"B","challenge":"c","id":"k"}', "GET passkeys"]);
    const declined = env({ list: [a, b], confirmed: false });
    await declined.removePasskey(b);
    expect(declined.order).toHaveLength(1);
    const last = env({ list: [a], fail: { "passkeys/delete": new Error("最後の 1 本は消せません") } });
    await last.removePasskey(a);
    expect(last.said.at(-1)).toEqual(["最後の 1 本は消せません", true]);
    // deleting this browser's own passkey: the page renders again (its cookie no longer counts)
    const own = env({ list: [a, b] });
    await own.removePasskey(a);
    expect(own.rendered).toEqual(["この端末のパスキーを消しました"]);
  });

  test("opened at #devices (or #countries) while the daemon starts, the page stays when it answers (review #2511)", async () => {
    for (const stay of ["devices", "countries"]) {
      const t = run({ states: ["pending", "running"], daemonAt: 6000, stay });
      await t.fns.waitForDaemon(0);
      expect(t.said).toContain("起動しました");
      expect(t.said.some((x) => x.startsWith("go "))).toBe(false);
      expect(t.shown.at(-1)!.ids).toEqual(["logout"]);
    }
    const plain = run({ states: ["pending", "running"], daemonAt: 6000 });
    await plain.fns.waitForDaemon(0);
    expect(plain.said).toContain("go /");
  });

  test("the card is in the page, hidden until a login, and #devices keeps the page open", () => {
    expect(page).toContain('<div class="card" id="devices" hidden>');
    expect(page).toContain('location.hash === "#devices"');
    expect(page).toContain("const stay = stays();");
  });
});
