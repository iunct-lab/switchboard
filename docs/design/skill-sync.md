# skill-sync (placing the development-standard skills in each repository)

Just before a Task's runner is started (`startSession` in `packages/core/src/tasks/sessions.ts`, before `adapter.start`), `syncSkills()` in `packages/core/src/skillsync.ts` places the development-standard skills of the meta workspace in the repository of the Task's working folder (2026-09-28).
It works in the same single place for a Task started by any route (a stage button, a hand-made Task, a schedule, a parallel run, a resume).

## How skills are placed

- Source of truth: of the meta workspace's `ops-kit/skills/<name>` (`SKILL_SOURCE`, the 11 of the common operations kit), those that have a `SKILL.md`. The skills specific to Switchboard (adopt-repo / flow-loop / new-repo / perf-loop / runner-adapter-recording / verify-live-ui, and any the repository keeps out of its public copy) stay in `.claude/skills` under Git management, and since they are not in the source of truth they are not placed (decided 2026-09-28)
- Destinations: the place the Task's runner reads, at the root of the repository (`SKILL_TARGET_OF`): `.claude/skills/<name>` for a Claude Code Task, `.agents/skills/<name>` for a Codex Task. A Task writes only its own runner's place, so a Claude Code Task and a Codex Task running side by side in one repository never rewrite each other's copies. A Task of a runner that reads neither place (ADK, AG-UI) places nothing
- Content: a **copy** of the source directory (real files. Links inside the source are copied as the real files, for both files and folders), with its Markdown files rendered for the Task (see "Splitting text by condition" below), and the marker file `.switchboard-skill` inside it (`SKILL_MARKER`; the hash of the copy's content as rendered, so a change of a condition — the review setting, the repository's `ops.config.json` — places the copy again). It is not a link because Claude Code's permission check looks at a link by its real path. With a link, in other repositories the real path is "outside the workspace", and reading the skill body with Bash (`sed` / `cat`) raises an approval prompt (decided 2026-10-05. Check it with `claude -p`). When the source is fixed, it is copied again at the next start
- Not made a Git-managed target: in the managed block of the file at `git rev-parse --git-path info/exclude` (`# >>> switchboard skills (managed)` to `# <<< switchboard skills`), the placed copies are written as lines of `/<destination>/<name>`. Outside the block and `.gitignore` are not touched. `info/exclude` is one file for all worktrees of the repository, so the block looks at all worktrees of `git worktree list` and makes lines for the places where some worktree has a Switchboard copy (including one of a skill that has disappeared from the source, until that worktree's next start removes it) or an old link (here a place can be `skipped` and yet be a copy in another worktree). Lines that are in no worktree are removed (if the user replaced a copy with their own folder, it is visible to Git). With 0 lines, the block is removed. Lines the user wrote inside the block are left outside the block. If the end marker has been erased, the block is taken to end at the first line that is not a managed one
- The meta repository (and its worktrees) also gets copies in the same way (the 4 specific ones are real Git-managed files with no marker and no same name in the source of truth, so they are not touched). When syncing another repository, the meta checkout is synced first. If the destination is the source directory itself (a link to it), that destination is skipped
- Does nothing: when the working folder is not Git

## How to tell the copies Switchboard placed

A real directory that has the marker file `.switchboard-skill` is taken to be a copy Switchboard placed. A real directory with no marker is the repository's own (including a Git-managed one) and is not touched.
The marker is the first file written into a copy and the last: before any file is copied it says `incomplete`, and it gets the hash only after every file is in place. A placing that stops part-way therefore leaves a marked copy whose marker is not the hash — never a directory without a marker, which would be read as the repository's own skill and left as it is. Such a copy is placed again at the next start, and until then it is not verified (below), so no runner starts on it. A directory with nothing in it (a placing that stopped before its first write) holds no skill and is placed like a missing one.
A symbolic link placed before the copies (an old link) is replaced by a copy once, at the next start. There are three kinds of old link: "a link that points inside the source", "a link that reaches inside the source through another link", and "a link that points at the meta `.claude/skills/<name>` (now meta's own copy)" (the third is what was placed before 2026-09-28, when the source of truth was meta's `.claude/skills`). A layer that keeps reading old links is not built.

| What is at the destination | Handling |
|---|---|
| Nothing, or a real directory with nothing in it | Place a copy (`linked`. The name of the result stays as it was in the days of links) |
| A marked copy whose marker hash and content equal the source as rendered for this Task | Not rewritten (`unchanged`) |
| A marked copy that differs from it (a change or deletion in the source, a changed condition, a hand edit of the copy, a placing that stopped part-way) | Delete and place again (`linked`). Files that disappeared from the source also disappear from the copy |
| An old link | Delete it and place a copy (`linked`). The link target (the source) is not changed |
| A real directory with files and no marker, a file, a link to somewhere else | Not touched (`skipped`). The Task's log says `スキル <name> はリポジトリにあるもの（<path>）を使います。Switchboard の正本は置いていません` |
| A marked copy or an old link whose name is not among the names to place (removed from the source) | Delete (`removed`) |

When `syncSkills` fails, the runner is started only if the copies already in the runner's place are verified to be the ones a sync would place now (`skillCopiesCurrent`: the same source rendered for the same conditions, by marker and by content) or there is no copy there: `スキルを置けませんでした: <理由>` is left in the log and the runner is started. Otherwise the start is refused — the Task ends in `error` with `スキルを今の設定（レビューするランナーなど）で置き直せず、置いてある写しが今の設定のものと確かめられないため、Task を始めません: <理由>` in its log — because the copies are the only place a runner reads the review setting from, and one left from an earlier start may be rendered for the other setting. The next start tries to place them again.

## Splitting text by condition

A skill used to carry both sides of every choice ("if Claude Code implemented … if Codex implemented …", "inside the app's Task … outside it …") and leave the runner to pick. A Task once asked the wrong runner for a review because the setting that decided it reached the Task only as an environment variable, while the text it read described the other side. Now the source says each side once, marked with its condition, and whoever hands the text to a runner renders it with the conditions it knows. The runner reads only its side, and a new setting does not add to what every Task reads.

**The mark** (`ops-kit/src/conditions.ts`). Two whole lines around the lines that belong to one side:

```
<!-- when review=same -->
…lines kept only when the review setting is "same"…
<!-- end when -->
```

- Several `key=value` in one mark are all required (`<!-- when task=in reviewer=codex -->`). There is no nesting and no else: the other side is its own block, and a block that needs two conditions names both in one mark
- A mark may stand anywhere a line can: inside a fenced code block (the mark lines are not part of the code), inside a table, and inside the frontmatter (a `description:` per side; every side must leave exactly one `name:` and one `description:`)
- A sentence in the middle of a long line is split by breaking the line at the sentence and marking that line. Text that reads the same on every side is written once, without a mark
- `renderConditions(text, conditions, path)` keeps the lines of the blocks that match and drops the marks and the other blocks. A broken mark (unknown key or value, nesting, a missing end) and a block whose key the caller did not give throw with the file and the line. `checkConditions` reports the same for every combination; `ops-kit/src/skills.test.ts` runs it over every skill and process definition

**The conditions** (`CONDITION_KEYS`; a new one is one line there, plus a value where the text is rendered):

| Key | Values | Where the value comes from when a skill is placed |
|---|---|---|
| `runner` | `claude` / `codex` | the Task's runner (the place being written) |
| `review` | `same` / `other` | the review setting as it is at the Task's start or resume |
| `reviewer` | `claude` / `codex` | the main reviewer; follows from the two above (`primaryReviewer`: the same runner for `same`, the other one for `other`) |
| `task` | `in` / `out` | always `in`: the app renders copies for its Tasks |
| `backlog` | `github` / `app` (a workspace whose backlog is kept in the app only) | the workspace's backlog (the meta checkout's copies use the meta workspace's) |
| `mergeGate` | `on` / `off` | whether the repository's `ops.config.json` has `mergeGate` |
| `extra` | `on` / `off` | whether the repository's `ops.config.json` has `extraReviewer` (the extra reviewer's name; how to call it stays in the repository's CLAUDE.md) |

**Who renders.**

- Skills: `syncSkills` renders every `*.md` of a skill when it places the copy. The source is never rewritten
- Process definitions (`ops-kit/processes/*.md`): `renderEntry(def, entry, vars, conditions)` renders an entry's blocks before it fills the `{{…}}` holes. The entries in the kit today need no block: the reviewer's name is a hole (`{{reviewer}}`) filled from the review setting
- Other text the app builds for a runner (a preamble, a request, a resume text) is built by a function of the conditions the app knows at that point, and holds only the sentences that match them ("Text the app builds for a Task" below). A text kept in a file can use `renderConditions` the same way; a text assembled in code takes the conditions as arguments, because its sentences differ inside a line and a mark is a whole line

### Text the app builds for a Task

A Task is told only what holds for it. The app decides when it builds the text; it does not write both sides for the runner to choose from.

| Text | Built by | Conditions | What they decide |
|---|---|---|---|
| Stop report at the start of a session | `stopRecoveryPrompt(open, cond)` in `packages/core/src/stops.ts` | Workspace MCP attached, a PBI's stage Task, plan mode | `task.note` or the `switchboard-stop` fence (one of the two); the `exec.run` sentence; the occupancy and parallel guard sentences; the plan-mode words |
| Preamble as a whole | `startSession` in `packages/core/src/tasks/sessions.ts` | new session or the same session continued; the insights schedule | A new session (a fork and a session whose record is not on this machine too) gets the stop report, the artifact paragraph, then a recap that ends with the heading of the person's message. A process started again on the same session gets only the stops still open. `/insights` gets nothing in front and no workspace rules after it |
| Stage request | `buildStartPrompt` in `packages/core/src/backlog-prompt.ts` | the stage merges or not (`actionMerges`), the runner, where the backlog and the changes are | The merge gate, recheck, local CI, release tag and rollback paragraphs only for a stage that merges; the slash command and the Agent tool paragraph only for Claude Code |
| Request, fix and baseline | `packages/core/src/feedback.ts` | the same, plus a checkout without a remote | A request Task files Issues and gets no PR rules; a fix on a checkout without a remote gets the local change's rules instead of the PR lines |
| Release review | `releaseReviewPrompt` in `packages/core/src/release-review.ts` | the runner | Claude Code's tool names only for Claude Code |
| Resume after a wait | `dependsResumePrompt` in `packages/core/src/depends-resume.ts` | waited for a PR or an Issue, or for a date only | The parallel guard only after a PR or an Issue |
| Stop of a post that holds a value | `ops-kit/bin/gh` | `DEVICE_AUTH_URL` given or not | One way to get an approval, not both |

- **The runner is known late.** A Task that starts by itself may start on another runner when the first one is at its limit, so `startMetaTask` takes the prompt as a function of the runner and calls it once the runner is decided. The same function writes the text again for a shadow on another runner (`promptFor`); a prompt a person typed is copied as it is.
- **Where the skills are.** The app's texts name the kit's skills by Claude Code's place; `skillPathsFor` (`packages/core/src/skillsync.ts`) rewrites those paths to the place of the Task's runner, which is the only place that Task's copies are in. A person's words inside the prompt (a request, an answer) are never rewritten.
- **Fixed grant sentences.** The stop report says that a merge outside the gate passes only with the sentence the refusing side prints, so a Task copies that sentence instead of writing its own.
- **Measuring.** `bun scripts/task-input.ts <task id>` prints what a Claude Code Task was given at its start, by route, in characters: the app's preamble, the request, the workspace's rules, each instruction file, the skill listing, the other attachments, and the first skill loaded.

### One way to say an operation

The documents a runner always reads must not describe one operation in two ways. `ops-kit/src/runner-docs.ts` lists the operations that were once described differently and the side that was decided (how a working directory is made, who posts a review, the attribution line, whether the question tool reaches a Task, waiting in the background, how a Task is told apart); `docViolations` returns the lines that say the other side. The kit checks its skills with it (`ops-kit/src/skills.test.ts`), and a repository checks what the kit cannot read — its `CLAUDE.md` and the skills it tracks itself — with the same list (`scripts/runner-docs-agree.test.ts` here). A new contradiction of a kind not listed is not caught: add a rule when one is found.

**The review setting takes effect in three places**, none of them an environment variable: the skills rendered at a Task's start or resume; the stage and fix prompts, which name the reviewer by the setting; and `ops-kit job request review`, where the app decides the reviewer when the job is asked for (`docs/design/daemon-jobs.md`). Tasks of one runner in one repository share one copy, so a Task that started before the setting changed reads the new side after another Task's start; the review job follows the setting at the time of the request either way, and refuses a runner the setting does not name.

**Readers outside a Task.** The source (and a copy of the kit made with `ops-kit export-copy`) keeps every side with its marks; the mark lines say which condition a block is for. A placed copy is the Task's side only (`task=in`), so its first line after the frontmatter names the source: a session started outside the app in the same repository (no `SWITCHBOARD_SUPERVISED`) reads the source instead. Outside the app there is no review setting; `cross-runner-review` says to read the `review=other` side.

## Conditional text inventory

Every place in the 11 shared skills (descriptions included) where the text depends on a condition. `split` rows are inside a block of that condition and side; `keep` rows stay as written, with the reason. Places are given by a phrase, not a line number (marks move the lines). `ops-kit/src/skills.test.ts` checks that every phrase is found in its file, that every `split` phrase occurs only inside a block of its condition and side, and that a line outside every block which holds one of the phrases that announce a condition (`CONDITION_PHRASES`: `アプリの Task の中` / `アプリの Task の外`, `GitHub 連携`, `ローカルのバックログ`, `mergeGate`, `<extra>`, `追加のレビュアー`, `別のランナー`, …) is a `keep` row here — so conditional text added without a mark fails the test until it is split or listed.

The branches of the form "if CLAUDE.md names it … otherwise …" are kept: what a repository states in prose is not known to the app when a Task starts. Conditions inside a repository's own tracked CLAUDE.md are listed and left to that repository.

| Condition | File | Phrase | Side | Decision | Reason |
|---|---|---|---|---|---|
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `PR を「実装したのとは別のランナー」（Cl` | `other+codex` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `PR を「実装したのとは別のランナー」（Co` | `other+claude` | split | names the main reviewer, which the review setting decides |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `cription: PR を「実装したのと同` | `same` | split | names the main reviewer, which the review setting decides |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `複数のレビューを集める（主レビュアー 1 +` | `on` | split | steps for the extra reviewer |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `レビューは主レビュアーの 1 つ（必要なら` | `off` | split | steps for the extra reviewer |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーは、アプリのレビューの設定（別の` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーは **Codex**（実装した` | `other+codex` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーは **Claude Code*` | `other+claude` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `レビュアーは **Claude Code の` | `same+claude` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーは **Codex の新しいセッ` | `same+codex` | split | names the main reviewer, which the review setting decides |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `- 材料・実行・転記・4 の見直しは下の手順` | `same` | split | names the main reviewer, which the review setting decides |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `追加のレビュアー（例: ローカルモデル）は、` | `on` | split | steps for the extra reviewer |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーが利用上限なら、**待たずに実装` | `other` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `Codex の 5 時間枠が **0.9 以` | `other+codex` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `Claude の枠（週間上限なども）が上限、` | `other+claude` | split | names the main reviewer, which the review setting decides |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `- 材料と指示は 1 と同じ fresh c` | `other` | split | names the main reviewer, which the review setting decides |
| `review+reviewer+task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `$N --runner claude --as` | `other+codex+in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `review+reviewer+task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `$N --runner codex --as` | `other+claude+in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `review+task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `- 直接走らせて代替するなら、2 の代替のラ` | `other+out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `で実際のランナーを who にし、要約の` | `other` | split | names the main reviewer, which the review setting decides |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーは実装したランナーと同じ枠を使う` | `same` | split | names the main reviewer, which the review setting decides |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーは自分のシェルで走らせず、アプリ` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `$N --runner codex --c` | `in+codex` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `$N --runner claude --c` | `in+claude` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `request が出す `job#<id>` と JSON を止まりの報告に書き` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `アプリの Task の外では直接走らせる。読` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `mergeGate` | `ops-kit/skills/cross-runner-review/SKILL.md` | `マージ判定が名指しの外のファイルを数える` | `on` | split | the list of files outside the Task's named paths comes from the merge gate, which only a repository that names one has |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `が名指しし、有効の条件を満たしていれば、ど` | `on` | split | steps for the extra reviewer |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `主レビュアーを仕事に頼んだらそこでターンを終` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task+extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `）は枠を通さないので仕事にしない。主レビュア` | `in+on` | split | steps for the extra reviewer |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `直接走らせるとき（アプリの Task の外）` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `直接走らせるときは `--idle 900`` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `レビューは重い処理の枠（席）を取らず` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `追加のレビュアー（ローカルモデルなら 50K` | `on` | split | steps for the extra reviewer |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `ex "$M/codex.md"   #` | `other+codex` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `e "$M/claude.md"   #` | `other+claude` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `codex "$M/codex.md" '` | `same+codex` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `laude "$M/claude.md" '` | `same+claude` | split | names the main reviewer, which the review setting decides |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `post_review $N <extra>` | `on` | split | steps for the extra reviewer |
| `reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `PREV=_review/codex.md` | `codex` | split | names the main reviewer, which the review setting decides |
| `reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `PREV=_review/claude.md` | `claude` | split | names the main reviewer, which the review setting decides |
| `task+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `の行は流さない）、WHO=codex、RC` | `in+codex` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task+reviewer` | `ops-kit/skills/cross-runner-review/SKILL.md` | `の行は流さない）、WHO=claude、R` | `in+claude` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/cross-runner-review/SKILL.md` | `# アプリの Task の外では直接走らせる` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `# 0 の代替で頼んだ見` | `other` | split | names the main reviewer, which the review setting decides |
| `review` | `ops-kit/skills/cross-runner-review/SKILL.md` | `NOTE='（同じランナーの別セッション。設` | `same` | split | names the main reviewer, which the review setting decides |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `/ nit c / question d）。` | `off` | split | steps for the extra reviewer |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `/ nit c / question d）、` | `on` | split | steps for the extra reviewer |
| `extra` | `ops-kit/skills/cross-runner-review/SKILL.md` | `- 追加のレビュアーを待ってマージを止める（` | `on` | split | steps for the extra reviewer |
| `task` | `ops-kit/skills/doc-to-slides/SKILL.md` | `（渡し方は成果物の登` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `runner` | `ops-kit/skills/issue-workflow/SKILL.md` | `を読む（中身は CLAUDE.md を指す` | `codex` | split | the runner's own tool or file |
| `backlog` | `ops-kit/skills/issue-workflow/SKILL.md` | `この workspace の Task は` | `app` | split | issues live on GitHub, or only in the app |
| `runner` | `ops-kit/skills/issue-workflow/SKILL.md` | `AskUserQuestio` | `claude` | split | the runner's own tool or file |
| `runner` | `ops-kit/skills/issue-workflow/SKILL.md` | `request_user_input` | `codex` | split | the runner's own tool or file |
| `task+backlog` | `ops-kit/skills/issue-workflow/SKILL.md` | `がある）、照会のたびに GitHub へは` | `in+github` | split | issues live on GitHub, or only in the app |
| `task+backlog` | `ops-kit/skills/issue-workflow/SKILL.md` | `がある。GitHub 連携の無い work` | `in+app` | split | issues live on GitHub, or only in the app |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `（アプリが Task に渡す）があればアプリの` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `Project にはアプリが入れる（--field` | `in` | split | the app adds an Issue a Task creates to the Project; outside a Task only `--field` does |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `アプリの Task の外では --field が無いと` | `out` | split | the app adds an Issue a Task creates to the Project; outside a Task only `--field` does |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `ops-kit task send <tas` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task+backlog` | `ops-kit/skills/issue-workflow/SKILL.md` | `未知の選択肢は送信で失敗する` | `in+github` | split | issues live on GitHub, or only in the app |
| `task+backlog` | `ops-kit/skills/issue-workflow/SKILL.md` | `未知の選択肢は断られる` | `in+app` | split | issues live on GitHub, or only in the app |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `未知の選択肢は、BACKLOG_URL が無ければ` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `質問ツールの無いランナー・アプリの外では` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/issue-workflow/SKILL.md` | `エージェント管理アプリの外（Task の id が無い）では` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `runner` | `ops-kit/skills/issue-workflow/SKILL.md` | `Codex の承認機構は` | `codex` | split | the runner's own tool or file |
| `runner` | `ops-kit/skills/issue-workflow/SKILL.md` | `ランナーの承認つきの実行（` | `codex` | split | the loopback refusal comes from the sandbox only Codex Tasks run in (permission-modes.md); the whole section is Codex's |
| `task` | `ops-kit/skills/pbi-complete/SKILL.md` | `- main の作業ツリーには触らない（wo` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/pbi-complete/SKILL.md` | `- エージェント管理アプリの Task とし` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `review+reviewer` | `ops-kit/skills/pbi-complete/SKILL.md` | `ーの利用上限の見方は CLAUDE.md。C` | `other+codex` | split | names the main reviewer, which the review setting decides |
| `review+reviewer` | `ops-kit/skills/pbi-complete/SKILL.md` | `の見方は CLAUDE.md。主レビュアー（` | `other+claude` | split | names the main reviewer, which the review setting decides |
| `review` | `ops-kit/skills/pbi-complete/SKILL.md` | `の見方は CLAUDE.md。主レビュアーは` | `same` | split | names the main reviewer, which the review setting decides |
| `extra` | `ops-kit/skills/pbi-complete/SKILL.md` | `- 同じ材料を CLAUDE.md の追加の` | `on` | split | steps for the extra reviewer |
| `task` | `ops-kit/skills/pbi-complete/SKILL.md` | `ops-kit job request re` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/pbi-complete/SKILL.md` | `アプリの Task の外では Bash の` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/pbi-complete/SKILL.md` | `ops-kit job request lo` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `mergeGate+task` | `ops-kit/skills/pbi-complete/SKILL.md` | `があるリポジトリのアプリの Task）。通` | `on+in` | split | the check in front of `gh` exists only where a merge gate is named |
| `runner` | `ops-kit/skills/pbi-complete/SKILL.md` | `上の形のままで通る` | `codex` | split | only a Codex Task cannot write under /tmp; the form of the command is the same for both |
| `mergeGate` | `ops-kit/skills/pbi-complete/SKILL.md` | `マージ判定のコマンドが無いリポジトリでは` | `off` | split | a named merge gate judges and merges with --merge / --merge-stack, so the steps for a repository without one are not carried |
| `mergeGate` | `ops-kit/skills/pbi-complete/SKILL.md` | `が無いリポジトリ（CLAUDE.md がマージ判定を名指ししない` | `off` | split | same |
| `reviewer+extra` | `ops-kit/skills/pbi-complete/SKILL.md` | `レビュー（codex/<extra` | `codex+on` | split | steps for the extra reviewer |
| `reviewer+extra` | `ops-kit/skills/pbi-complete/SKILL.md` | `ビュー（codex）` | `codex+off` | split | steps for the extra reviewer |
| `reviewer+extra` | `ops-kit/skills/pbi-complete/SKILL.md` | `レビュー（claude/<extra>）` | `claude+on` | split | steps for the extra reviewer |
| `reviewer+extra` | `ops-kit/skills/pbi-complete/SKILL.md` | `レビュー（claude）` | `claude+off` | split | steps for the extra reviewer |
| `task` | `ops-kit/skills/public-release-gate/SKILL.md` | `env -u CLAUDECODE -u C` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `backlog` | `ops-kit/skills/request-to-backlog/SKILL.md` | `y Points・元要望への参照）にして G` | `github` | split | issues live on GitHub, or only in the app |
| `backlog` | `ops-kit/skills/request-to-backlog/SKILL.md` | `ry Points・元要望への参照）にしてア` | `app` | split | issues live on GitHub, or only in the app |
| `backlog` | `ops-kit/skills/request-to-backlog/SKILL.md` | `作った Issue は番号が付くまで` | `github` | split | issues live on GitHub, or only in the app |
| `backlog` | `ops-kit/skills/request-to-backlog/SKILL.md` | `作った Issue は作成で番号が付く（Gi` | `app` | split | issues live on GitHub, or only in the app |
| `task` | `ops-kit/skills/request-to-backlog/SKILL.md` | `（exit 2 になるのはアプリに届かない・` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `extra` | `ops-kit/skills/review-triage-and-merge/SKILL.md` | `（追加のレビュアーは未着でもよく、届いたら転` | `on` | split | steps for the extra reviewer |
| `mergeGate+task` | `ops-kit/skills/review-triage-and-merge/SKILL.md` | `PR #<n> を判定の外でマージし` | `on+in` | split | the check in front of `gh` exists only where a merge gate is named |
| `backlog` | `ops-kit/skills/stacked-pr-delivery/SKILL.md` | `は Task の PR だけで、手順が残る` | `github` | split | issues live on GitHub, or only in the app |
| `backlog` | `ops-kit/skills/stacked-pr-delivery/SKILL.md` | `Task は GitHub の Issue` | `app` | split | issues live on GitHub, or only in the app |
| `mergeGate` | `ops-kit/skills/stacked-pr-delivery/SKILL.md` | `にその引数が無いリポジトリでは` | `off` | split | same as in pbi-complete: a named merge gate has --merge / --merge-stack |
| `backlog` | `ops-kit/skills/task-to-pr/SKILL.md` | `# 題: feat(core): … (#` | `github` | split | issues live on GitHub, or only in the app |
| `backlog` | `ops-kit/skills/task-to-pr/SKILL.md` | `# 題: feat(core): … (T` | `app` | split | issues live on GitHub, or only in the app |
| `runner` | `ops-kit/skills/task-to-pr/SKILL.md` | `上の `mktemp` の形は Codex の Task でも` | `codex` | split | only a Codex Task cannot write under /tmp; the form of the command is the same for both |
| `task` | `ops-kit/skills/task-to-pr/SKILL.md` | `がローカル CI を名指しするとき）: 自` | `in` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `task` | `ops-kit/skills/task-to-pr/SKILL.md` | `がローカル CI を名指しするとき）: ア` | `out` | split | a Task asks the app (a job, a stop report); a session outside it runs the command itself |
| `backlog` | `ops-kit/skills/task-to-pr/SKILL.md` | `Closes #<Task>。<何を・なぜ。` | `github` | split | issues live on GitHub, or only in the app |
| `backlog` | `ops-kit/skills/task-to-pr/SKILL.md` | `（上の 1 行はこの節の先頭に、それだけで置` | `app` | split | issues live on GitHub, or only in the app |
| `extra` | `ops-kit/skills/review-triage-and-merge/SKILL.md` | `<extra> ` | `on` | split | steps for the extra reviewer |
| `backlog` | `ops-kit/skills/cross-runner-review/SKILL.md` | `単独行の Backlog-Task: N（ローカルのバックログ` | both | keep | one chain of commands reads the Task number in every form a PR body can carry; splitting it would fork the script |
| `extra` | `ops-kit/skills/issue-workflow/SKILL.md` | `追加のレビュアー（任意。例: ローカルモデル）とその呼び方` | both | keep | a line of the checklist of what a repository declares in its CLAUDE.md, not a step |
| `review` | `ops-kit/skills/public-release-gate/SKILL.md` | `別のランナーや提供者へ送る経路` | both | keep | a seed of what to inspect in the tree, not the review setting |
| `review` | `ops-kit/skills/public-release-gate/SKILL.md` | `片方のランナーを別のランナーで代替する` | both | keep | the gate always runs both runners; the line says not to substitute one |
| `CLAUDE.md` | `ops-kit/skills/pbi-complete/SKILL.md` | `CLAUDE.md が名指しする` | both | keep | a value the repository states in prose (a command, a procedure); the app does not know it when a Task starts |
| `CLAUDE.md` | `ops-kit/skills/task-to-pr/SKILL.md` | `CLAUDE.md が名指しする` | both | keep | same: the repository states it in prose |
| `CLAUDE.md` | `ops-kit/skills/review-triage-and-merge/SKILL.md` | `CLAUDE.md が名指し` | both | keep | same: the repository states it in prose |
| `CLAUDE.md` | `ops-kit/skills/issue-workflow/SKILL.md` | `使う側のリポジトリが持つもの` | both | keep | the section that lists what each repository states; every "if CLAUDE.md names it" branch of the skills resolves there |
| `forge` | `ops-kit/skills/pbi-complete/SKILL.md` | `Stacked PR（gh stack）で積み` | both | keep | the description names stacked PRs although a repository without a remote uses local changes; whether the repository has a remote is not one of the conditions, and the body says what to do instead (the `ローカルの変更では` paragraphs) |
| `forge` | `ops-kit/skills/stacked-pr-delivery/SKILL.md` | `ローカルの変更では` | both | keep | same: the paragraph for a repository without a remote stays next to the PR steps |
| `forge` | `ops-kit/skills/cross-runner-review/SKILL.md` | `ローカルの変更では` | both | keep | same |
| `repository` | `CLAUDE.md` | `Actions が始まらない` | both | keep | the repository's own tracked file: whether Actions run and whether a build off the host exists are its values; the app never rewrites tracked files |

## Copies of the operations tools (scripts/setup)

Unlike skills, the entry points of `scripts/setup/` are **not distributed; only the existence of a copy is reported** (2026-10-02). The entry points are Git-managed files of each repository, part of that repository's configuration together with `ops.config.json`. Replacing them with links or rewriting them would change tracked files, which goes against the policy above of "not changing tracked files". Replacing the entry points with ones that call the kit is done in each repository.

- Definition of a copy: a file in the repository's `scripts/setup/` that has the same name (without the extension) as an entry point of meta's `scripts/setup/` but whose content does not contain `src/cli.ts` (`copies` of `setupScripts()`). Both the kit itself (`$K/src/cli.ts`) and the copy a public repository bundles (`<bundle destination>/src/cli.ts`) fall on the "calls the kit" side (`kit`) by this one rule. A name not in meta (such as DAK's `install_hooks.sh`) is a script specific to that repository and is not counted
- Detection: right after the skill sync in `startSession`. For each copy, the Task's status gets `scripts/setup/<名前> は共通キットを呼ばない写しです。検査の結果が共通スキルとずれることがあります` ("`scripts/setup/<name>` is a copy that does not call the common kit. The result of a check can drift from the common skills")
- It does not stop: the runner is started even if there is a copy, and even when `scripts/setup` could not be read (`scripts/setup を調べられませんでした: <理由>` is left)

## Primary sources (checked 2026-09-28)

- Claude Code — https://code.claude.com/docs/en/skills
  - "Claude Code loads project skills from `.claude/skills/` in the directory where you start it and in every parent directory up to the repository root"
  - "**Symlinked folders**: a `<skill-name>` entry in the enterprise, personal, or project location can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill once even if several locations point at the same target."
- Codex — https://learn.chatgpt.com/docs/build-skills (the destination of the redirect from the old https://developers.openai.com/codex/skills)
  - A repository's skills are the `.agents/skills` of each directory from the working folder up to the repository root (and `$REPO_ROOT/.agents/skills`). A user's skills are `$HOME/.agents/skills`
  - "Codex supports symlinked skill folders and follows the symlink target when scanning these locations."

## Out of scope

- Placing at the user level (`~/.claude/skills`, `~/.agents/skills`) (replaced by syncing to each repository, in the answer of 2026-09-28)
- Rewriting the skill bodies (making them generic is separate work)
- Letting the source through with an approval setting (`additionalDirectories`) — it would write a Switchboard path into another repository's settings, which goes against the repository boundary (decided 2026-10-05)
- The daemon writing hook registrations into each repository (`shared-tmp-guard.md`. The daemon passes them with `--settings`; it is a separate matter when a repository registers one in its own settings)
