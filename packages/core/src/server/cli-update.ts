/**
 * The daemon's side of bringing the host's Claude Code and Codex CLIs up to date: it reads the distributors on an
 * interval, checks and tries a new version when it is due, and moves the link only when no Task runs. The checks and
 * the move are cli-update-source.ts and cli-update-install.ts; this is when they run and what the API shows. Not run by
 * a daemon that decides nothing (a candidate on a copy of the database, a work machine), which must not move the host's CLI.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliRollbackResult, CliUpdateRunner, CliUpdateState } from "@switchboard/protocol";
import { compareVersions, download, isDue, latestVersion, readLatest, realCliSourceDeps, verify, withdrawn, type CliRelease, type CliRunner, type CliSourceDeps } from "../cli-update-source.ts";
import { currentVersion, hostInstallDeps, placesOf, prune, rolledAwayFrom, rollback, rollbackTarget, smoke, stage, swap, type InstallDeps } from "../cli-update-install.ts";
import type { CliUpdateRow } from "../db/cli-updates.ts";
import { decidesNothing } from "../machine.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";

const RUNNERS: readonly CliRunner[] = ["claude", "codex"];
const NOT_OURS = "置き場所の symlink が無い（インストーラで入れていない）ので、今の版が分からず何もしない";
const WAIT_TASKS = "確かめは通った。Task が動いているので、空くまで入れ替えを待つ";

/** What the daemon keeps of the update between firings. Memory only: a restart reads the distributors again and the record is in the database. */
export interface CliUpdateRuntime {
  timer: ReturnType<typeof setTimeout> | null;
  /** Verified, placed and tried under the settings in `key`: waits for no Task to run. */
  ready: Map<CliRunner, { release: CliRelease; key: string }>;
  /** Found but not yet old enough (`waitHours`). */
  held: Map<CliRunner, { version: string; reason: string }>;
  /** `<version>|<the two settings that decide>` of each version refused, so none is downloaded again until one of the settings changes. */
  refused: Map<CliRunner, Set<string>>;
  checkedAt: Map<CliRunner, number>;
  rollbackWanted: Set<CliRunner>;
  /** Why a rollback asked for earlier (answered 202) could not be done; shown in the state until the next one is done. */
  rollbackFailed: Map<CliRunner, string>;
  checking: boolean;
  /** One thing at a time touches the links. */
  chain: Promise<unknown>;
  source: CliSourceDeps | null;
}

type Sc = Pick<ServerContext, "cfg" | "opts" | "db" | "settings" | "cliUpdate" | "drainBusy" | "stopped">;

const installDeps = (sc: Pick<ServerContext, "opts" | "db">): InstallDeps => ({ ...hostInstallDeps(sc.db), ...sc.opts.cliUpdate?.install });
const sourceDeps = async (sc: Pick<ServerContext, "opts" | "cliUpdate">): Promise<CliSourceDeps> => (sc.cliUpdate.source ??= sc.opts.cliUpdate?.source ?? (await realCliSourceDeps()));
const serial = <T>(sc: Pick<ServerContext, "cliUpdate">, fn: () => Promise<T>): Promise<T> => {
  const run = sc.cliUpdate.chain.then(fn, fn);
  sc.cliUpdate.chain = run.catch(() => undefined);
  return run;
};

const newer = (a: string, b: string): boolean => compareVersions(a, b) > 0;
/** No wait means no wait: a publish time a little ahead of this host's clock does not hold a version. */
const due = (release: CliRelease, waitHours: number, now: number): boolean => waitHours <= 0 || isDue(release, waitHours, now);
/** The two settings a check depends on: a version checked under other values is checked again, not moved in. */
const settingsKey = (sc: Pick<ServerContext, "settings">): string => `${sc.settings().cliUpdate.missingSignature}|${sc.settings().cliUpdate.smoke}`;

const refusedOf = (rt: CliUpdateRuntime, runner: CliRunner): Set<string> => {
  let set = rt.refused.get(runner);
  if (!set) rt.refused.set(runner, (set = new Set()));
  return set;
};

/** One row, unless the runner's last row already says the same (a version held or refused is told once, not on every firing). */
function record(sc: Pick<ServerContext, "db">, row: Omit<CliUpdateRow, "at">, now: number): void {
  // a refusal (or a wait, or an untried check) of a version is told once, even after rows of other versions in between
  const told = sc.db.listCliUpdates(1000).some((r) => r.runner === row.runner && r.outcome === row.outcome && r.toVersion === row.toVersion && r.reason === row.reason);
  if (told && row.outcome !== "installed" && row.outcome !== "rolled-back") return;
  sc.db.addCliUpdate({ at: now, ...row });
}

/** Forgets the version waiting for the Tasks, and its files unless they are what runs or what a rollback goes to (the two `prune` keeps). */
function dropReady(sc: Pick<ServerContext, "opts" | "db" | "cliUpdate">, runner: CliRunner): void {
  const waiting = sc.cliUpdate.ready.get(runner);
  sc.cliUpdate.ready.delete(runner);
  if (!waiting) return;
  const inst = installDeps(sc);
  const v = waiting.release.version;
  if (currentVersion(runner, inst) === v || rollbackTarget(runner, inst) === v) return;
  rmSync(placesOf(runner, inst.home, inst.codexTarget).dir(v), { recursive: true, force: true });
}

async function checkOne(sc: Sc, runner: CliRunner): Promise<void> {
  const rt = sc.cliUpdate;
  const inst = installDeps(sc);
  const now = inst.now();
  const cur = currentVersion(runner, inst);
  if (cur === null) {
    dropReady(sc, runner);
    rt.held.delete(runner);
    return;
  }
  // the settings the whole check runs under: a version is ready only for these (settle compares them again)
  const opts = sc.settings().cliUpdate;
  const key = settingsKey(sc);
  const src = await sourceDeps(sc);
  const refuse = (version: string, release: CliRelease | null, reason: string) => {
    record(sc, { runner, fromVersion: cur, toVersion: version, outcome: "refused", sha256: release?.sha256 ?? null, reason, by: "auto" }, now);
    if (release) refusedOf(rt, runner).add(`${version}|${key}`);
    dropReady(sc, runner);
    rt.held.delete(runner);
  };
  // the name only first (a few bytes): the release, its checksum list and signature are read when there is something new
  const latest = await latestVersion(runner, src);
  rt.checkedAt.set(runner, now); // the distributor was read (a host without the link reads nothing and keeps no time)
  if (typeof latest !== "string") return refuse("unknown", null, `${latest.reason}: ${latest.detail}`);
  const queued = rt.ready.get(runner);
  // the distributor's newest went back below a version that waits for the Tasks: it is withdrawn, and says so
  if (queued && newer(queued.release.version, latest)) refuse(queued.release.version, queued.release, `withdrawn: the newest is ${latest}, older than ${queued.release.version}`);
  if (!newer(latest, cur)) {
    rt.held.delete(runner);
    dropReady(sc, runner);
    return;
  }
  // a version a person went back from is not brought in again by itself
  if (rolledAwayFrom(runner, inst).has(latest)) {
    rt.held.delete(runner); // nothing is waited for: an older hold must not stay on the screen
    return;
  }
  if (refusedOf(rt, runner).has(`${latest}|${key}`)) return;
  const waiting = rt.ready.get(runner);
  if (waiting?.release.version === latest && waiting.key === key && due(waiting.release, opts.waitHours, now)) return;
  const read = await readLatest(runner, src);
  if (!read.ok) return refuse(latest, null, `${read.reason}: ${read.detail}`);
  const release = read.release;
  if (!newer(release.version, cur) || rolledAwayFrom(runner, inst).has(release.version)) return;
  if (!due(release, opts.waitHours, now)) {
    const hours = Math.ceil((release.publishedAt + opts.waitHours * 3_600_000 - now) / 3_600_000);
    rt.held.set(runner, { version: release.version, reason: `出てから ${opts.waitHours} 時間待つ（あと約 ${hours} 時間）` });
    // the reason it is not in yet goes in the record too (once per version: the hours left are only on the screen)
    record(sc, { runner, fromVersion: cur, toVersion: release.version, outcome: "waiting", sha256: release.sha256, reason: `出てから ${opts.waitHours} 時間待つ`, by: "auto" }, now);
    return;
  }
  rt.held.delete(runner);
  dropReady(sc, runner);

  await src.tmp(async (dir) => {
    const file = join(dir, "download");
    const outside = await download(release.assetUrl, file, src);
    if (outside) return refuse(release.version, release, `${outside.reason}: ${outside.detail}`);
    const verdict = await verify(file, release, { missingSignature: opts.missingSignature }, src);
    if (!verdict.ok) return refuse(release.version, release, `${verdict.reason}: ${verdict.detail}`);
    const p = placesOf(runner, inst.home, inst.codexTarget);
    const placedNow = !existsSync(p.dir(release.version));
    try {
      await stage(runner, release, file, inst);
    } catch (e) {
      return refuse(release.version, release, `置けなかった: ${(e as Error).message.slice(0, 200)}`);
    }
    // The one turn is run here, once, before the version waits for the Tasks; the move does not run another (see settle).
    const checked = await smoke(runner, release, p.bin(release.version), opts.smoke, inst);
    if (!checked.ok) {
      if (placedNow) rmSync(p.dir(release.version), { recursive: true, force: true });
      if (checked.limit) record(sc, { runner, fromVersion: cur, toVersion: release.version, outcome: "untested", sha256: release.sha256, reason: checked.reason, by: "auto" }, now);
      else refuse(release.version, release, checked.reason);
      return;
    }
    rt.ready.set(runner, { release, key });
  });
}

/** Moves each checked version in, and does each rollback asked for, when no Task is running. A rollback asked during a pass gets another pass. */
async function settle(sc: Sc): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    await settleOnce(sc);
    if (sc.cliUpdate.rollbackWanted.size === 0 || sc.stopped || sc.drainBusy() > 0) return;
  }
}

async function settleOnce(sc: Sc): Promise<void> {
  const rt = sc.cliUpdate;
  if (rt.ready.size === 0 && rt.rollbackWanted.size === 0) return;
  const inst = installDeps(sc);
  /** A person's rollback wins over a version waiting to go in (one already being moved in goes first; the rollback then goes from it). */
  const goBack = async (runner: CliRunner) => {
    rt.rollbackWanted.delete(runner);
    const back = await rollback(runner, "person", inst).catch((e: Error) => ({ ok: false as const, outcome: null, reason: e.message }));
    if (back.ok) rt.rollbackFailed.delete(runner);
    else {
      rt.rollbackFailed.set(runner, `頼まれた戻しができなかった: ${back.reason}`);
      console.warn(`cli-update: ${runner}: rollback: ${back.reason}`);
    }
    dropReady(sc, runner);
    rt.held.delete(runner);
  };
  for (const runner of RUNNERS) {
    if (sc.stopped || sc.drainBusy() > 0) break;
    if (rt.rollbackWanted.has(runner)) {
      await goBack(runner);
      continue;
    }
    const ready = rt.ready.get(runner);
    if (!ready) continue;
    const { release } = ready;
    /** Checked under other settings (a stricter signature rule, a turn now required) or a wait now longer: check it again instead of moving it in. */
    const stillFits = () => ready.key === settingsKey(sc) && due(release, sc.settings().cliUpdate.waitHours, inst.now());
    if (!stillFits()) {
      dropReady(sc, runner);
      continue;
    }
    const cur = currentVersion(runner, inst);
    if (cur === null || !newer(release.version, cur)) {
      dropReady(sc, runner); // the link moved past it some other way
      continue;
    }
    // withdrawn since it was checked: it may have waited hours for the Tasks
    let verdict;
    try {
      verdict = await withdrawn(release, await sourceDeps(sc));
    } catch {
      continue; // the distributor did not answer: it stays ready and is asked again when the Tasks next end
    }
    if (!verdict.ok) {
      record(sc, { runner, fromVersion: currentVersion(runner, inst), toVersion: release.version, outcome: "refused", sha256: release.sha256, reason: `${verdict.reason}: ${verdict.detail}`, by: "auto" }, inst.now());
      refusedOf(rt, runner).add(`${release.version}|${settingsKey(sc)}`);
      dropReady(sc, runner);
      continue;
    }
    if (sc.drainBusy() > 0) break; // a Task started while the distributor was asked
    if (rt.rollbackWanted.has(runner)) {
      await goBack(runner); // asked while the distributor was asked
      continue;
    }
    if (!stillFits()) {
      dropReady(sc, runner); // the settings changed while the distributor was asked
      continue;
    }
    // The turn already ran, on these same files, when the version was checked: the move reads `--version` again but does
    // not run a second turn (this `turn` is the one already passed). Right before the link moves, everything is asked
    // again: the `--version` above takes time, and a Task, a rollback or a setting may have come in meanwhile.
    const canMove = () => !sc.stopped && sc.drainBusy() === 0 && !rt.rollbackWanted.has(runner) && stillFits();
    const done = await swap(runner, release, { smoke: ready.key.split("|")[1] as "turn" | "version", by: "auto", canMove }, { ...inst, turn: async () => undefined });
    if (!done.ok && done.outcome === null) {
      if (!stillFits()) dropReady(sc, runner);
      continue; // not moved: it waits for the next signal
    }
    dropReady(sc, runner);
    if (done.ok) prune(runner, inst);
    else if (done.outcome === "refused") {
      refusedOf(rt, runner).add(`${release.version}|${ready.key}`); // not fetched again under these settings
      if (currentVersion(runner, inst) !== release.version) rmSync(placesOf(runner, inst.home, inst.codexTarget).dir(release.version), { recursive: true, force: true });
    }
  }
  // what is still waiting says so in the record, once
  if (sc.drainBusy() > 0) {
    const inst2 = installDeps(sc);
    for (const [runner, { release }] of rt.ready) record(sc, { runner, fromVersion: currentVersion(runner, inst2), toVersion: release.version, outcome: "waiting", sha256: release.sha256, reason: WAIT_TASKS, by: "auto" }, inst2.now());
  }
}

/** Reads the distributors, and tries what is new and due. A distributor that does not answer is tried again at the next firing. */
export const checkCliUpdates = async (sc: Sc): Promise<void> => {
  if (decidesNothing(sc.cfg) || sc.cliUpdate.checking) return;
  sc.cliUpdate.checking = true;
  try {
    await serial(sc, async () => {
      for (const runner of RUNNERS) {
        if (sc.stopped) return;
        try {
          await checkOne(sc, runner);
        } catch (e) {
          console.warn(`cli-update: ${runner}: ${(e as Error).message}`);
        }
      }
      await settle(sc);
    });
  } catch (e) {
    console.warn(`cli-update: ${(e as Error).message}`);
  } finally {
    sc.cliUpdate.checking = false;
  }
};

/** Called when a Task's turn or the Task ends: what is ready goes in once nothing runs. */
export const swapWhenIdle = (sc: Sc): void => {
  if (decidesNothing(sc.cfg) || sc.cliUpdate.ready.size + sc.cliUpdate.rollbackWanted.size === 0) return;
  void serial(sc, () => settle(sc)).catch((e) => console.warn(`cli-update: ${(e as Error).message}`));
};

export const armCliUpdateCheck = (sc: Pick<ServerContext, "cfg" | "opts" | "settings" | "cliUpdate" | "armCliUpdateCheck" | "checkCliUpdates" | "stopped">): void => {
  if (decidesNothing(sc.cfg)) return;
  const rt = sc.cliUpdate;
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = setTimeout(() => {
    if (sc.stopped) return;
    sc.armCliUpdateCheck();
    void sc.checkCliUpdates();
  }, sc.opts.cliUpdate?.checkMs ?? sc.settings().cliUpdate.checkMinutes * 60_000);
  rt.timer.unref();
};

export const cliUpdateState = (sc: Sc): CliUpdateState => {
  const inst = installDeps(sc);
  const rt = sc.cliUpdate;
  return {
    enabled: !decidesNothing(sc.cfg),
    runners: RUNNERS.map((runner) => {
      const current = currentVersion(runner, inst);
      const ready = rt.ready.get(runner);
      const previous = rollbackTarget(runner, inst);
      return {
        runner,
        current,
        previous,
        previousGone: previous !== null && !existsSync(placesOf(runner, inst.home, inst.codexTarget).bin(previous)),
        waiting: ready ? { version: ready.release.version, reason: sc.drainBusy() > 0 ? WAIT_TASKS : "確かめは通った。入れ替え中" } : (rt.held.get(runner) ?? null),
        rollbackWaiting: rt.rollbackWanted.has(runner),
        checkedAt: rt.checkedAt.get(runner) ?? null,
        note: current === null ? NOT_OURS : (rt.rollbackFailed.get(runner) ?? null),
      };
    }),
    records: sc.db.listCliUpdates(50) as CliUpdateState["records"],
  };
};

/** Puts the CLI back to the version before the last install: now when no Task runs, else once none does. */
export const requestCliRollback = async (sc: Sc, runner: CliUpdateRunner): Promise<{ status: number; body: CliRollbackResult }> => {
  const no = (reason: string, to: string | null = null) => ({ status: 409, body: { ok: false, waiting: false, to, reason } });
  if (decidesNothing(sc.cfg)) return no("この Switchboard では CLI の更新を動かさない（候補のデーモン・作業場のマシン）");
  const inst = installDeps(sc);
  if (currentVersion(runner, inst) === null) return no(NOT_OURS);
  const target = rollbackTarget(runner, inst);
  if (!target) return no("戻す先の版（ここで確かめて入れた前の版）が記録に無い");
  if (!existsSync(placesOf(runner, inst.home, inst.codexTarget).bin(target))) return no(`${target} のファイルが無い`, target);
  const later = (why: string) => {
    sc.cliUpdate.rollbackWanted.add(runner);
    // what runs may still change before then (a version already being moved in), so the target is the one at that time
    return { status: 202, body: { ok: true, waiting: true, to: target, reason: `${why}ので、空いたらそのときの前の版（今は ${target}）に戻す` } };
  };
  // A check holds the links for minutes (download, signature, one turn): wait for it like for a Task instead of hanging the request.
  if (sc.drainBusy() > 0) return later("Task が動いている");
  if (sc.cliUpdate.checking) return later("新しい版を確かめている");
  // Asked again inside the line: a Task may have started while it waited.
  // The answer names the version actually put back: a move already in the line may have changed the target.
  const done = await serial(sc, async () => (sc.drainBusy() > 0 ? null : { done: await rollback(runner, "person", inst), to: currentVersion(runner, inst) }));
  if (done === null) return later("Task が動いている");
  if (done.done.ok) sc.cliUpdate.rollbackFailed.delete(runner);
  dropReady(sc, runner);
  sc.cliUpdate.held.delete(runner);
  return done.done.ok ? { status: 200, body: { ok: true, waiting: false, to: done.to, reason: `${done.to} に戻した` } } : no(done.done.reason, target);
};

export function setupCliUpdate(sc: Pick<ServerContextInit, "cfg" | "opts" | "tasks" | "cliUpdate" | "swapWhenIdle" | "armCliUpdateCheck" | "checkCliUpdates" | "stopped">): void {
  sc.cliUpdate = { timer: null, ready: new Map(), held: new Map(), refused: new Map(), checkedAt: new Map(), rollbackWanted: new Set(), rollbackFailed: new Map(), checking: false, chain: Promise.resolve(), source: null };
  if (decidesNothing(sc.cfg)) return;
  sc.armCliUpdateCheck();
  // the daemon restarts on every promotion, so the first read does not wait for a whole interval
  const first = setTimeout(() => { if (!sc.stopped) void sc.checkCliUpdates(); }, sc.opts.cliUpdate?.checkMs ?? 30_000);
  first.unref();
  const idle = () => sc.swapWhenIdle();
  sc.tasks.onTurnEnd(idle);
  sc.tasks.onTaskEnd(idle);
  sc.tasks.onBackgroundEmpty(idle);
}
