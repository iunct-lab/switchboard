// `bun test` の全ファイルに掛かる前後の処理（bunfig.toml の `[test] preload`）。
// 止め忘れた TaskManager のキューのタイマーを見つける: タイマーは閉じた DB に対して鳴り続け、同じプロセスで後から走る
// 別のテストの console.error に `queue tick failed` を書く（console.error を差し替えて読むテストが、無関係な行で落ちる）。
// テストのファイルが替わっても残っているタイマーは、その場で止め（後のテストを汚さない）、最後に、作ったファイルと行の名前つきで
// 失敗にする。直し方は、TaskManager を作ったテストが終わりに `shutdown()`（`startServer` なら `stop()`）を呼ぶか、
// ファイルの afterEach で `stopArmedQueues()`（packages/core/src/tasks/state.ts）を呼ぶこと。
// packages/core は import しない（どのテストでもデーモンのコードを読むことになる）。印は globalThis の同じ Symbol で共有する。
import { afterAll, afterEach, beforeEach } from "bun:test";

type Queue = { stopQueue(): void };
const KEY = Symbol.for("switchboard.armed-queue-timers");
const armed = (): Set<Queue> => ((globalThis as unknown as Record<symbol, Set<Queue> | undefined>)[KEY] ??= new Set());

/**
 * `set` に入っているタイマーの見張り 1 つ（状態は自分で持つ。テストは自分の `set` で別に作る）。
 * `watch`: `set` に入る時点（タイマーを掛けた時点）のテストのファイルと、呼び出しの中でいちばん近いテストの行を覚える。
 * `sweep`: 今のファイルより前のファイルが残したタイマーを止めて数える。`all` は最後の 1 回（今のファイルの分も）。
 * `report`: 残したファイルの一覧の 1 行ずつ。無ければ空。読むと消える。
 */
export function queueWatch(set: Set<Queue>, file: () => string) {
  const madeIn = new WeakMap<Queue, { file: string; at?: string }>();
  const leaked = new Map<string, { n: number; at: Set<string> }>();
  return {
    watch(): void {
      const add = set.add.bind(set);
      set.add = (q) => {
        const at = /([^\s()/]+\.test\.tsx?:\d+):\d+/.exec(new Error().stack ?? "")?.[1];
        madeIn.set(q, { file: file(), ...(at ? { at } : {}) });
        return add(q);
      };
    },
    sweep(all = false): void {
      const now = file();
      for (const q of [...set]) {
        // made before the watch (none in a normal run): taken as this file's
        const from = madeIn.get(q) ?? { file: now };
        madeIn.set(q, from);
        if (from.file === now && !all) continue;
        q.stopQueue();
        set.delete(q);
        const l = leaked.get(from.file) ?? { n: 0, at: new Set<string>() };
        l.n++;
        if (from.at) l.at.add(from.at);
        leaked.set(from.file, l);
      }
    },
    report(): string[] {
      const lines = [...leaked].map(([f, l]) => `${f}: TaskManager のキューのタイマーを ${l.n} 個止めずに終わった（shutdown() か startServer の stop() を呼ぶ）${l.at.size ? `。作った行: ${[...l.at].slice(0, 5).join("、")}` : ""}`);
      leaked.clear();
      return lines;
    },
  };
}

// the run's own watch, once per process (a test that imports this file must not add a second one)
const RUN = Symbol.for("switchboard.armed-queue-watch");
const g = globalThis as unknown as Record<symbol, true | undefined>;
if (!g[RUN]) {
  g[RUN] = true;
  const run = queueWatch(armed(), () => Bun.main);
  run.watch();
  // before a test too: what the file before left must not tick during this file's first test
  beforeEach(() => run.sweep());
  afterEach(() => run.sweep());
  afterAll(() => {
    run.sweep(true);
    const lines = run.report();
    if (lines.length) throw new Error(`止め忘れたキューのタイマー:\n${lines.join("\n")}`);
  });
}
