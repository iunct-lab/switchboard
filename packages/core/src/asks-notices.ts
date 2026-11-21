/**
 * The notices among the questions waiting on the user (asks.ts): what a scheduled check found — a secret scan's
 * findings, a result that needs a look — shown until it is answered or the thing it names is gone.
 */
import type { Ask, AskAnswerKind, ScheduleResult } from "@switchboard/protocol";
import { ASK_HISTORY_MS } from "./backlog-comments.ts";
import { remedyLines } from "./secretscan.ts";
import { unanswered } from "./asks.ts";

/**
 * The daemon's notices as of now, kept between reads under one setting, by what they are about (a workspace, a
 * schedule): the question's id and first sight, when it was first seen gone, and what the screen showed for it (a
 * resolved one is no longer in the input to read it from). A scan's notice keeps its hits' fingerprint, and the one
 * the person dismissed.
 */
export type NoticeRecord = Record<
  string,
  { id: string; at: number; resolvedAt: number | null; question: string; source: string; workspace: { id: string; name: string } | null; fingerprint?: string; dismissed?: string | null; /** The person closed it (dismiss): not shown, even as resolved. */ closed?: boolean }
>;

/** What a secret-scan result's notice is about: its hit lines (places and kinds, no values) and the repositories it could not check. */
/** `fingerprint` is the hits' only: what a dismiss closes (a repository that could not be checked is not a false positive). */
export function scanFindings(result: ScheduleResult | null): { hits: string[]; failed: string[]; fingerprint: string } {
  const lines = result?.lines ?? [];
  const hits = lines.filter((l) => l.startsWith("  ")).map((l) => l.trim());
  // anything but a repository's count line: a repository it could not check, or a firing that failed as a whole
  const failed = lines.filter((l) => !l.startsWith("  ") && !/: (0 件|当たり \d+ 件)（scanned \d+）$/.test(l));
  return { hits, failed, fingerprint: [...hits].sort().join("\n") };
}

/** The hits a dismiss closes: those closed before and the ones the notice shows now, one line each. */
export const closedHits = (r: NoticeRecord[string]): string =>
  [...new Set([...(r.dismissed ?? "").split("\n"), ...(r.fingerprint ?? "").split("\n")].filter(Boolean))].sort().join("\n");

/** What to do about a scan notice: look, then the clean-up of each kind that was hit (`remedyLines`; no value, no URL). */
const scanNext = (hits: readonly string[]): string =>
  ["内容の URL を開いて当たりが本物の値か見る。本物なら下の片づけ方で片づける（次の検査で当たりが無くなれば解消済み）。誤検知なら「誤検知として閉じる」", ...remedyLines(hits).map((l, i) => `${i ? "" : "片づけ方 — "}${l}`)].join("。");

const CLI_WHY: Record<string, string> = { "not-official": "配布元の外", mismatch: "checksum が配布元と合わない", withdrawn: "配布元が取り下げた", unsigned: "署名が無い（設定で拒む）" };
/** A refusal row's `<reason>: <detail>` for the screen: the four reasons of the source check in words, any other already is. */
const cliReason = (reason: string): string => {
  const i = reason.indexOf(": ");
  const why = i < 0 ? undefined : CLI_WHY[reason.slice(0, i)];
  return why ? `${why}: ${reason.slice(i + 2)}` : reason;
};
/** The reason in a few words, for the question line (the card folds the body, and a safety reason must not be folded). */
const cliWhyShort = (reason: string): string => {
  const i = reason.indexOf(": ");
  const why = i < 0 ? undefined : CLI_WHY[reason.slice(0, i)];
  const text = why ?? (i < 0 ? reason : reason.slice(0, i));
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/**
 * The daemon's notices as questions: built from the current state each time, never written as notes.
 * - a workspace a Task cannot use (`unusableWorkspaces`): open until it is fixed, then resolved with no answer
 * - a secret-scan schedule's last result with hits or a repository it could not check: open, answered by `dismiss`
 *   (a false positive) — the same hits do not come back, new ones do; resolved once a result is clean
 * - an approval-window schedule that fired, while SSO / deploy batches wait (`approvalWindowNote`): open with no answer
 *   (the batches are answered on their cards), resolved once none waits
 * - the same firing, while the newest tag waits for running Tasks (`promotionNote`): open with no answer (promoted
 *   from the header's 「新しい版 →」), resolved once the hold is gone
 * - a promotion whose wait for the Tasks went past its limit (`drainNote`): open with no answer from the moment the
 *   limit passed, whatever the schedules — the app cuts no Task for it, so the person is the one who decides to
 *   (設定 → 動いている版 → 待たずに昇格する); resolved once the Tasks stopped or the version went in
 * - a tag the tag CI holds back from the automatic promotion (`tagCiNote`): open with no answer from the first check
 *   that held it, one per tag; resolved once the tag went in or a newer tag took its place
 * - what a work machine put and this instance did not take in (`refused`: a delta, a backlog edit): one notice per
 *   machine, open from the first refusal and answered by `dismiss` (seen) — the same objects do not come back, a new
 *   refusal opens it again. Nothing is decided for them: the objects were passed over and the later ones went on
 * - a host CLI's version this instance did not put in (`cliRefused`): one notice per runner, open from the refusal and
 *   answered by `dismiss` (seen) — the same version does not come back, a newer version's refusal opens it again; the
 *   caller leaves a runner out once a later version went in, which resolves it (never `untested` or `waiting`: nobody
 *   can fix those, the next check goes on)
 * A resolved one drops off a day later. Returns the record to keep (the same object when nothing changed).
 */
export function noticeAsks(
  input: {
    unusable: Array<{ workspace: { id: string; name: string }; why: string }>;
    /** `workspace` = the schedule's (meta), shown as where the notice belongs. */
    scans?: Array<{ schedule: { id: string; title: string }; workspace?: { id: string; name: string } | null; result: ScheduleResult | null }>;
    windows?: Array<{ schedule: { id: string; title: string }; workspace?: { id: string; name: string } | null; note: { title: string; body: string } | null }>;
    /** approval-window schedules again, with the promotion held for running Tasks (`promotionNote`); a notice of its own. */
    promotions?: Array<{ schedule: { id: string; title: string }; workspace?: { id: string; name: string } | null; note: { title: string; body: string; at: number } | null }>;
    /** The promotion that has waited past its limit for the Tasks a restart would cut (`drainNote`), or null. */
    drain?: { note: { title: string; body: string; at: number } | null; workspace?: { id: string; name: string } | null };
    /** The tag the tag CI holds back from the automatic promotion (`tagCiNote`), or null. */
    /** What each work machine put and this instance refused (uplink-s3.ts, backlog-upbox.ts): the object's key and why. */
    refused?: Array<{ machine: string; key: string; reason: string }>;
    /** A host CLI's newest version this instance did not put in (`refused` rows of the update history, none installed since): the runner, the version, why (`<reason>: <detail>`), the version in use. */
    cliRefused?: Array<{ runner: string; version: string; reason: string; current?: string | null; at: number }>;
    tagCi?: { note: { tag: string; title: string; body: string; at: number } | null; workspace?: { id: string; name: string } | null };
    now: number;
  },
  record: NoticeRecord,
): { asks: Ask[]; record: NoticeRecord } {
  const { now } = input;
  const next: NoticeRecord = {};
  let changed = false;
  const asks: Ask[] = [];
  const notice = (r: NoticeRecord[string], reason: string | null, todo: string | null, answers: AskAnswerKind[]): Ask => ({
    ...unanswered,
    id: r.id,
    kind: "notice",
    needs: "person",
    state: r.resolvedAt === null ? "open" : "resolved",
    at: r.at,
    changedAt: r.resolvedAt ?? r.at,
    workspace: r.workspace,
    pbi: null,
    issue: null,
    task: null,
    reason,
    question: r.question,
    choices: [],
    recommendation: null,
    next: todo,
    source: { label: r.source, url: null, taskId: null },
    route: "none",
    conditions: [],
    answers: r.resolvedAt === null ? answers : [],
  });
  const same = (a: NoticeRecord[string] | undefined, b: NoticeRecord[string]) => !!a && JSON.stringify(a) === JSON.stringify(b);
  for (const u of input.unusable) {
    const key = `workspace:${u.workspace.id}`;
    const had = record[key];
    const open = had && had.resolvedAt === null;
    const r = { id: `notice:${key}`, at: open ? had.at : now, resolvedAt: null, question: `workspace ${u.workspace.name} を使えません`, source: "workspace の検査", workspace: u.workspace };
    if (!same(had, r)) changed = true;
    next[key] = r;
    // the reason's last sentence says how to fix it
    const cut = u.why.lastIndexOf("。", u.why.length - 2);
    asks.push(notice(r, cut < 0 ? u.why : u.why.slice(0, cut + 1), cut < 0 ? null : u.why.slice(cut + 1), []));
  }
  for (const scan of input.scans ?? []) {
    const key = `scan:${scan.schedule.id}`;
    const had = record[key];
    const f = scanFindings(scan.result);
    // each hit the person closed as a false positive stays closed; a failure is never closed (it resolves once a scan passes)
    const closedSet = new Set((had?.dismissed ?? "").split("\n").filter(Boolean));
    const hits = f.hits.filter((h) => !closedSet.has(h));
    const dismissed = f.hits.length > 0 && hits.length === 0;
    const fingerprint = [...hits].sort().join("\n");
    if (!hits.length && !f.failed.length) {
      if (dismissed) {
        // the closed hits are remembered; what was open (a failure next to them) is resolved now, shown for a day
        const r = had!.resolvedAt === null ? { ...had!, resolvedAt: now } : had!;
        if (r !== had) changed = true;
        next[key] = r;
        if (!r.closed && now - r.resolvedAt! <= ASK_HISTORY_MS) asks.push(notice(r, null, null, []));
      }
      continue; // clean (or never run): an open one is resolved below
    }
    const question = `認証の値の検査: 当たり ${hits.length} 件 / 検査できなかった ${f.failed.length} リポジトリ`;
    const open = had && had.resolvedAt === null && had.fingerprint === fingerprint && had.question === question;
    const at = open ? had.at : now;
    const r = {
      id: `notice:${key}@${at}`,
      at,
      resolvedAt: null,
      question,
      source: `予定「${scan.schedule.title}」`,
      workspace: scan.workspace ?? null,
      fingerprint,
      dismissed: had?.dismissed ?? null,
    };
    if (!same(had, r)) changed = true;
    next[key] = r;
    asks.push(notice(r, [...hits, ...f.failed].join("\n"), scanNext(hits), hits.length ? ["dismiss"] : []));
  }
  // what a work machine put and was not taken in: per machine, the objects the person has not seen yet
  const byMachine = new Map<string, Array<{ key: string; reason: string }>>();
  for (const r of input.refused ?? []) byMachine.set(r.machine, [...(byMachine.get(r.machine) ?? []), r]);
  for (const [machine, list] of byMachine) {
    const key = `uplink-refused:${machine}`;
    const had = record[key];
    const seen = new Set((had?.dismissed ?? "").split("\n").filter(Boolean));
    const fresh = list.filter((r) => !seen.has(r.key));
    const fingerprint = fresh.map((r) => r.key).sort().join("\n");
    if (!fresh.length) {
      // all of them seen: remembered, not shown (a later refusal opens the notice again)
      next[key] = had!;
      continue;
    }
    const open = had && had.resolvedAt === null && had.fingerprint === fingerprint;
    const at = open ? had.at : now;
    const r = { id: `notice:${key}@${at}`, at, resolvedAt: null, question: `作業場 ${machine} から届いたもの ${fresh.length} 件を取り込まなかった`, source: "作業場からの取り込み", workspace: null, fingerprint, dismissed: had?.dismissed ?? null };
    if (!same(had, r)) changed = true;
    next[key] = r;
    asks.push(notice(r, fresh.map((x) => `${x.key}: ${x.reason}`).join("\n"), "取り込まなかったものは飛ばし、後から届いたものは取り込みを続けている（飛ばしたものに続く記録だけは、同じ理由で止まる）。中身はこのインスタンスに入っていない。原因を直してから作業場で送り直す（docs/design/work-machine.md）。確かめたら「誤検知として閉じる」で閉じる（同じものは再び出ない）", ["dismiss"]));
  }
  for (const c of input.cliRefused ?? []) {
    const key = `cli:${c.runner}`;
    const had = record[key];
    const seen = new Set((had?.dismissed ?? "").split("\n").filter(Boolean));
    // a refusal before the version's name could be read ("unknown") is one per reason, not one for every unknown
    const fp = c.version === "unknown" ? `unknown|${c.reason}` : c.version;
    if (seen.has(fp)) {
      next[key] = had!; // seen: remembered, not shown (a refusal of another version opens it again)
      continue;
    }
    const open = had && had.resolvedAt === null && had.fingerprint === fp;
    const at = open ? had.at : now;
    const r = { id: `notice:${key}@${at}`, at, resolvedAt: null, question: `${c.runner} ${c.version} を入れませんでした（${cliWhyShort(c.reason)}）`, source: "CLI の更新", workspace: null, fingerprint: fp, dismissed: had?.dismissed ?? null };
    if (!same(had, r)) changed = true;
    next[key] = r;
    asks.push(notice(r, [cliReason(c.reason), c.current ? `拒んだときの版: ${c.current}` : "拒んだときの版: 不明"].join("\n"), "配布元の告知を見る。新しい版が通れば自動で入り、この知らせは解消済みになる。確かめたら「誤検知として閉じる」で閉じる（同じ版は再び出ない）", ["dismiss"]));
  }
  const daily: Array<{ key: string; first: number | null; todo: string; /** The notice is the same one whenever it is seen again (its id does not carry the time). */ once?: boolean; source?: string; schedule?: { id: string; title: string }; workspace?: { id: string; name: string } | null; note: { title: string; body: string } | null }> = [
    ...(input.drain ? [{ ...input.drain, key: "promotion-drain", first: input.drain.note?.at ?? null, source: "動いている版", todo: "待つならそのまま（Task が全部止まれば自動で昇格する）。待たないなら、設定の「動いている版」で「待たずに昇格する」を押す（動いている・待っている Task は切れる）" }] : []),
    // keyed by the tag: one notice per held tag, and a newer tag's replaces it
    ...(input.tagCi?.note ? [{ ...input.tagCi, key: `promotion-tag-ci:${input.tagCi.note.tag}`, once: true, first: input.tagCi.note.at, source: "動いている版", todo: "タグの CI が通れば自動で昇格する（新しいタグが付けばそちらに移る）。待たずに上げるなら、設定の「動いている版」で昇格する。結果の無いタグを自動で上げるかは、同じ場所の「自動で上げるタグ（タグの CI）」" }] : []),
    ...(input.windows ?? []).map((w) => ({ ...w, key: `approval-window:${w.schedule.id}`, first: null, todo: "判断待ちのまとまりのカードでログイン・承認する（待ちが無くなれば解消済み）" })),
    ...(input.promotions ?? []).map((w) => ({ ...w, key: `promotion:${w.schedule.id}`, first: w.note?.at ?? null, todo: "ヘッダーの「新しい版 →」から「待たずに昇格する」を押す（昇格するか Task が空いて自動で昇格すれば解消済み）" })),
  ];
  for (const w of daily) {
    if (!w.note) continue; // nothing waits: an open one is resolved below
    const had = record[w.key];
    // a promotion's first sight is its hold's (the same hold is one notice)
    // a tag's notice is raised once: seen again after a moment without the hold (a daemon restart), it is the same one
    const at = had && (had.resolvedAt === null || w.once) ? had.at : (w.first ?? now);
    const r = { id: w.once ? `notice:${w.key}` : `notice:${w.key}@${at}`, at, resolvedAt: null, question: w.note.title, source: w.source ?? `予定「${w.schedule?.title ?? ""}」`, workspace: w.workspace ?? null };
    if (!same(had, r)) changed = true;
    next[w.key] = r;
    asks.push(notice(r, w.note.body, w.todo, []));
  }
  for (const [key, had] of Object.entries(record)) {
    if (next[key]) continue;
    if (!had.id) {
      changed = true; // not a record this reads
      continue;
    }
    // a dismissed scan whose hits are gone has nothing left to show; nor has a machine's notice whose objects were all seen
    const shown = !had.closed;
    const r = had.resolvedAt === null ? { ...had, resolvedAt: now } : had;
    if (r !== had) changed = true;
    if (!shown || now - r.resolvedAt! > ASK_HISTORY_MS) {
      changed = true;
      continue;
    }
    next[key] = r;
    asks.push(notice(r, null, null, []));
  }
  return { asks, record: changed ? next : record };
}
