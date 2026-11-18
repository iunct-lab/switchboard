/**
 * What the documents a runner always reads (the skills, a repository's CLAUDE.md and the like) say in one way only.
 * Each rule is an operation that two documents once described differently, so that a runner had to pick one; the side
 * that was decided is written here once, and a line that says the other side is a violation. The kit checks its own
 * skills with these (`skills.test.ts`); a repository checks the documents the kit cannot read (its CLAUDE.md, the
 * skills it tracks itself) with the same list.
 */
export type DocRule = {
  name: string;
  /** The decided side, for the message. */
  say: string;
  /** Whether the line says the other side. */
  bad: (line: string) => boolean;
};

const ASKING = /AskUserQuestion|request_user_input|質問ツール/;
const WAITING = /run_in_background|`sleep`|\bsleep \d/;
/** What a line that names a background wait must also say: that it is not done, or where it is right. */
const WAITING_SAID = /待たない|にしない|Task の外|直接回す|直接走らせる/;
const TELLS_A_TASK = /(自分は|自分が)[^。\n]*Task|Task (の中)?かどうか|Task の(中|外)[（(]|(あれば|無ければ)（[^）\n]*Task の(中|外)）/;

/**
 * The rule that a Task is told apart in one way. `others` = the variables a Task also has that must not be said to
 * tell; `the` = the one variable that does, where the document is the one that names it. The kit's skills name none
 * (the repository's CLAUDE.md does), so the kit's own rule has no `the`.
 */
export const tellsATaskBy = (others: RegExp, the?: string): DocRule => ({
  name: "telling a Task",
  say: the ? `アプリの Task かどうかを見分ける変数は \`${the}\` だけ` : "アプリの Task かどうかの見分け方はリポジトリの CLAUDE.md が書く（スキルは変数を名指ししない）",
  bad: (l) => TELLS_A_TASK.test(l) && others.test(l) && !(the && l.includes(the)),
});

export const DOC_RULES: DocRule[] = [
  {
    name: "working directory",
    say: '作業ファイルの置き場は `mktemp -d "${TMPDIR:-/tmp}/<名前>.XXXXXX"` の 1 つの形（`/tmp/` の直書きは Codex の Task で失敗する）',
    bad: (l) => /mktemp -d \/tmp\//.test(l),
  },
  {
    name: "who posts a review",
    say: "レビュアーは PR に書かず、実装者が接頭辞つきで転記する（`cross-runner-review` の 3）",
    bad: (l) => /(投稿|コメント)させ/.test(l),
  },
  {
    name: "attribution line",
    say: "コミットと PR の帰属の行は、そのときランナーが受けている指示に従う（1 つのランナーの行を直書きしない）",
    bad: (l) => /Generated with \[Claude Code\]|Claude-Session:|Co-Authored-By: Claude/.test(l),
  },
  {
    name: "asking",
    say: "質問ツールはアプリの Task に届く（運用の確認に使う。`issue-workflow` の「運用の確認」）",
    bad: (l) => ASKING.test(l) && /届かない/.test(l),
  },
  {
    name: "waiting",
    say: "Task はローカル CI とレビューを仕事に頼んでターンを終える。背景の待ちを書く行は、待たないと言うか、直接回す条件を言う",
    bad: (l) => WAITING.test(l) && !WAITING_SAID.test(l),
  },
  tellsATaskBy(/BACKLOG_URL|OPS_KIT_TASK_ID/),
];

/** The lines of `text` that say the other side of a rule: `<path>:<line>: <rule> — <the decided side>`. */
export function docViolations(text: string, path: string, rules: DocRule[] = DOC_RULES): string[] {
  return text.split("\n").flatMap((line, i) => rules.filter((r) => r.bad(line)).map((r) => `${path}:${i + 1}: ${r.name} — ${r.say}`));
}
