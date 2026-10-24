# 同時編集でも値を黙って失わない同期（方式 B の調査、#899）

## 実現（#1329、方式 1′）

利用者の回答で 1′ を縮小 4 点つきで実現した: 書いた直後の読みが編集履歴も読み、照合の読みから書き込みまでの間の相手の編集を `overwritten` 付きの `conflict` にする（`backlog-send.ts`、[backlog-sync.md](backlog-sync.md) の「送り方」）。取込みはその競合を閉じず、外部を選ぶと相手の値を送り返す（`db.ts`）。履歴を読めない・読み切れない・制限に当たったときは未確認の競合、409 / 412 は照合し直して競合。`limits` は対象ごとに残る窓を名指しする（`backlog.ts` の `SYNC_LIMITS`）。bench（`bun scripts/backlog-race-bench.ts --fixture`。フィールドは本文: 消える・押し出される場合があるのは本文・コメントなので）の結果:

| 時点 | `github`（置き換え + 履歴） | `github-project-field`（履歴なし） | `conditional` |
|---|---|---|---|
| 通知欠落・照合前 | held（照合） | held | held |
| **照合と書き込みの間** | **held、`recoverable` = [v2]**（履歴から相手の値） | done、**v2 を失う** | held（412 → 照合し直し） |
| 履歴の版の内容が消された | held、`traced`（編集者・時刻だけ） | done、v2 を失う | held |
| 履歴の版が押し出された | **done、v2 を失う**（残る窓） | done、v2 を失う | held |
| 履歴を読めない | held（未確認） | —（履歴を読まないので該当なし。done、v2 を失う） | held |
| 書き込み直後 | held | held | done（相手が拒まれる） |
| 応答消失 | held | held | held |

`a.loses` = ["history-evicted"]、`b.needs` = 履歴の無いフィールドと押し出された版の 2 つ。各行の呼び出しは照合 1 + 書き込み 1 + 直後の読み 1 の 3 回以内（履歴で増えない）。受け入れ条件 7（実 GitHub で題の編集を挟む確認）は利用者確認。以下は調査時の記録（#927 / #928）。

初期方式 A（[backlog-sync.md](backlog-sync.md) の「送り方」「取込みと競合」、#887）は、送る直前と直後に GitHub の値を読んで競合を保留する。**読んでから書くまでの間の GitHub 側の編集は防げない**。利用者の追加要望（#882）の B は、その窓も含めて「Switchboard と GitHub / GitLab の双方から同じフィールドを更新しても、片方の変更を黙って失わない」こと。この文書は、その窓を偽の forge で再現し（#927）、B に必要な条件と実現の候補（#928）を書く。調査の完了は B の実現ではない。

## 保証対象（#927）

- **対象**: 1 つのフィールド（Issue の本文・題・状態・ラベル・Milestone・親、Project のフィールド）を両側が別の値にしたとき、どちらの値も、forge の上か、手元の操作（`backlog_operations` の `conflict` に GitHub の値と一緒）か、書いた本人への拒否（書けなかったと本人が知る）のどれかに残ること。「黙って」は、3 つのどこにも残らず、誰にも知らされないこと
- **対象でないもの**: 観測できた版を保管するだけのこと（A が既にする。見えなかった版は保管できない）、コメントの二重投稿を避けること（A の印、`backlog-sync.md`）。本文の自動マージ（A と同じく、しない）

## 再現（#927）

```bash
bun scripts/backlog-race-bench.ts --fixture      # gh は起動しない。実 GitHub に何も書かない
env -u SWITCHBOARD_SUPERVISED bun test scripts/backlog-race-bench.test.ts
```

[`scripts/backlog-race-bench.ts`](../../scripts/backlog-race-bench.ts) は、偽の forge（Issue 1 件・1 フィールド（#927 では題、#1329 で本文に変更: 消える・押し出される版があるのは本文・コメントだけ）・書き込みごとの版番号）に対して実物の `sendGithubOperations`（[`backlog-send.ts`](../../packages/core/src/backlog-send.ts)）と `Db` を回す。両側の出発点は v1、相手の編集は v2、手元の編集は v3。相手の編集を送信の 5 つの時点（と、照合と書き込みの間の編集の版が読む前に履歴から消えた `history-deleted`（内容だけ消え、編集者と時刻は残る）・`history-evicted`（100 版を超えて押し出され、何も残らない）・`history-unreadable`（履歴はあるが読めない: 403 かページが欠けた）。forge のフィールドは本文（#1329 で題から変更）で、消える・押し出される 2 つは本文・コメントの `userContentEdits` の場合 — timeline のイベントについては、GitHub の文書に上限・削除の記載が無い（無いことの確認は 2026-10-12 の文書の範囲まで。実現 PBI で `timelineItems(since:)` が古いイベントも返すことを実 GitHub で 1 回確かめる））に差し込み、forge を 3 種で回す（結果 JSON の `forge`）:

- **条件なし**（`github`。今の GitHub の Issue のフィールド）: 書き込みは今の値を置き換える。置き換えた値は編集履歴に残る（`recoverable`: 失った値のうち履歴が返すもの）
- **条件なし・履歴なし**（`github-project-field`。今の GitHub の Status 以外の Project フィールド）: 同じく置き換えるが、前の値はどこにも残らない
- **条件つき**（`conditional`。CAS）: 書く側が最後に読んだ版でなければ書き込みを拒む（412）。相手の編集も、手元の書き込みより前に読んだ値の上の編集なら拒まれる

| 時点 | 条件なし: forge / 手元 / 失う | 条件つき: forge / 手元 / 失う |
|---|---|---|
| 通知欠落（相手が先に書き、取込みも通知も来ないまま手元が v1 の上で編集） | v2 / 保留（v2 を添えて） / なし | 同じ |
| 照合前（手元の編集の後、送る前に相手が書く） | v2 / 保留 / なし | 同じ |
| **照合と書き込みの間** | **v3 / done / v2 を失う。誰にも知らされない**（`github` では履歴が v2 を返す = `recoverable`。`github-project-field` では返らない） | v2 / 拒否（今の A は `failed`）/ なし |
| 照合と書き込みの間 + 履歴の版の内容が消された（`history-deleted`） | v3 / done / v2 を失う。`github` でも `recoverable` は空で、`traced`（誰かが書いた跡だけ）が true | v2 / 拒否 / なし |
| 照合と書き込みの間 + 履歴の版が押し出された（`history-evicted`） | v3 / done / v2 を失う。`recoverable` も `traced` も無い（履歴の無いフィールドと同じ） | v2 / 拒否 / なし |
| 照合と書き込みの間 + 履歴が読めない（`history-unreadable`） | v3 / done / v2 を失う。`historyRead` が false: 何も分からない | v2 / 拒否 / なし |
| 書き込み直後（相手が、手元の書き込みより前に読んだ値の上で書く） | v2 / 保留（直後の読みで気づく） / なし | v3 / done（相手が拒まれ、本人は知る） / なし |
| 応答消失（書けたが答えが届かず、待ってから送り直す。その間に相手が v3 の上で書く） | v2 / 保留 / なし | 同じ |

読みは照合の 1 回と、書いたあとの 1 回（書かなければ無い。応答消失の行では送り直しの照合がその 2 回目）、書き込みは 0〜1 回。どの行も 3 呼び出し以内（結果 JSON の `calls` / `writes`）。`github-project-field` の値は条件なしと同じで、`recoverable` は空、`traced` / `historyRead` は常に false（履歴そのものが無い）。結果 JSON の `a` は、今の GitHub（`github`）に対して A が気づいた時点（`detects`）・失った時点（`loses`）・失ったが履歴が返す時点（`recovers`）、`b.needs` は B に足りない条件を、表の中身ではなく実行結果から出す。

### A で検出できる範囲と、反例

- A が気づくのは、照合の読み（送る直前）と直後の読みで**値が違って見える**とき。通知の欠落・遅延は窓を広げない（照合は通知ではなく GitHub の今の値を読む）。応答消失の送り直しも照合から始まるので同じ
- 反例は 1 つ: **照合と書き込みの間**に相手が書いた値。手元の書き込みが置き換え、直後の読みは自分の値を読み返すので、A は何も見ない。窓の長さは GraphQL の読み 1 回と REST の書き 1 回の間（秒以下）だが、ゼロにはならない。この行が `limits` の「上書きしうる」（`readStoredIssue`）の中身
- 条件つきの forge では反例が消える。代わりに手元の書き込みが拒まれ、今の A はそれを `failed`（自動では送り直さない）にする。B の実現では、拒否を「照合をやり直して `conflict` に回す」と読み替える必要がある（`Sender.set` の `refused` の分岐）

### B に足りない必要条件

反例を消すには、次のどれかが要る。どれも A の送信側だけでは満たせない:

1. **サービス側の条件つき書き込み**: 書き込みに「この版の上でなら」を付けられ、違えば拒まれること（上の条件つき forge）。GitHub の REST の `PATCH /repos/{owner}/{repo}/issues/{n}` と GraphQL の `updateIssue` / `updateProjectV2ItemFieldValue` にその入力が無ければ、この経路では満たせない（一次資料の確認は #928）
2. **置き換えない書き方**: 同じフィールドを置き換えず、変更を追記（コメント・提案）して誰かが採用する。本文・題には使えるが、状態・ラベル・Project のフィールドは置き換えしかない
3. **書く経路を 1 本にする**: GitHub 側から直接書かない（Switchboard だけが書く）か、書く前に取る排他（ロック）を両側が守る。「GitHub だけを見る人にも従来の操作を続けさせる」（#882）と衝突する

候補の比較と、GitHub の API が 1 を持つかどうかは次の節。実現は上の「実現（#1329）」。

## 実現候補と要件判断（#928）

調査日: 2026-10-12。一次資料は GitHub の REST / GraphQL の文書と、GraphQL のスキーマ（`gh api graphql` の introspection。入力の型と履歴のイベント型は文書の索引からは読めないので、スキーマを正とし、下に記録した）、GitLab の API 文書。認証の値は作っていない。

一次資料:
- REST「Update an issue」: https://docs.github.com/en/rest/issues/issues#update-an-issue（ヘッダは `accept` だけ、本文に期待値なし。応答は 200 / 301 / 403 / 404 / 410 / 422 / 503）
- REST の条件つき要求: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api（"Conditional requests for unsafe methods, such as POST, PUT, PATCH, and DELETE are not supported" — 続けて "unless otherwise noted in the documentation for a specific endpoint"。Update an issue の文書には何も書かれていない）
- REST timeline（`renamed` の `rename.from` / `to` など。本文の編集と Project v2 のフィールド変更のイベントは無い）: https://docs.github.com/en/rest/issues/timeline
- 編集履歴の保持と削除: https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment（"GitHub retains a maximum of 100 edits per content item"。超えると古い中間の版から消え、元の内容と新しい 99 版が残る。コメントの作者と書き込み権限のある人は履歴から版の内容を消せる。編集者と時刻は残る）
- GraphQL のスキーマ（introspection。入力型のフィールド名と、timeline のイベント型）: 下の記録
- GitLab「Edit an issue」: https://docs.gitlab.com/api/issues/#edit-an-issue、ノート: https://docs.gitlab.com/api/notes/、resource events: https://docs.gitlab.com/api/resource_label_events/

GraphQL スキーマの記録（2026-10-12、`gh api graphql -f query='{ __type(name:"<型>"){ inputFields { name } } }'` と `fields { name }`。期待値・版・前提の入力が無いことの根拠）:

| 型 | フィールド |
|---|---|
| `UpdateIssueInput` | clientMutationId, id!, title, body, assigneeIds, assignees, milestoneId, labelIds, labels, state, stateInput, projectIds, issueTypeId, issueType, issueFieldUpdates, agentAssignment |
| `UpdateIssueCommentInput` | clientMutationId, id!, body! |
| `UpdateProjectV2ItemFieldValueInput` | clientMutationId, projectId!, itemId!, fieldId!, value! |
| `ClearProjectV2ItemFieldValueInput` | clientMutationId, projectId!, itemId!, fieldId! |
| `CloseIssueInput` | clientMutationId, issueId!, stateReason, duplicateIssueId, rationale, isSuggestion, confidence |
| `AddSubIssueInput` | clientMutationId, issueId!, subIssueId, subIssueUrl, replaceParent |
| `CreateCommitOnBranchInput`（参考） | clientMutationId, branch!, fileChanges, message!, **expectedHeadOid!** |
| `UserContentEdit` | createdAt, deletedAt, deletedBy, diff, editedAt, editor, id, updatedAt（`Comment` を実装する Issue / IssueComment / PullRequest … に `userContentEdits`） |
| `RenamedTitleEvent` | actor, createdAt, currentTitle, id, previousTitle, subject |
| `ProjectV2ItemStatusChangedEvent` | actor, createdAt, id, previousStatus, project, status, wasAutomated |
| `ProjectV2ItemFieldSingleSelectValue` / `…NumberValue` | …, createdAt, creator, updatedAt（前の値は無い） |
| `IssueTimelineItems` の Project v2 のイベント | AddedToProjectV2Event, RemovedFromProjectV2Event, ProjectV2ItemStatusChangedEvent（この 3 つだけ） |
| `Issue.timelineItems` の引数 | since, skip, itemTypes, after, before, first, last |

### 対象ごとの対応表

| 対象 | 条件つき更新（期待値つきの書き込み） | 原子的な比較 | 履歴の取得（相手の値を後から読めるか） |
|---|---|---|---|
| Issue 本文 | **なし**。REST `PATCH /repos/{owner}/{repo}/issues/{n}` に前提のヘッダも期待値の入力も無い。REST の条件つき要求は GET だけ（[best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api): "Conditional requests for unsafe methods, such as POST, PUT, PATCH, and DELETE are not supported"）。GraphQL `UpdateIssueInput` も `id` / `title` / `body` / … だけ | なし | **あり**: `Issue.userContentEdits`（`diff` / `editedAt` / `editor`）、`lastEditedAt` |
| Issue 題 | なし（同上） | なし | **あり**: `timelineItems(itemTypes: RENAMED_TITLE_EVENT, since:)` の `RenamedTitleEvent`（`previousTitle` / `currentTitle` / `actor` / `createdAt`）。REST timeline の `renamed`（`rename.from` / `to`）も同じ |
| 状態 | なし（`CloseIssueInput` は `stateReason` など） | なし | あり: `ClosedEvent` / `ReopenedEvent` |
| ラベル | なし。ただし追加・削除は集合への操作で、同じ名前を 2 回足しても 1 つ（置き換えより衝突しにくい） | なし | あり: `LabeledEvent` / `UnlabeledEvent`（`label` / `actor`） |
| Milestone | なし | なし | あり: `MilestonedEvent` / `DemilestonedEvent`（`milestoneTitle`） |
| 親（sub-issue） | なし（`AddSubIssueInput.replaceParent` は置き換えの指示） | なし | あり: `ParentIssueAddedEvent` / `ParentIssueRemovedEvent` |
| Project のフィールド | **なし**。`UpdateProjectV2ItemFieldValueInput` は `projectId` / `itemId` / `fieldId` / `value` だけ | なし | **Status だけ**: `ProjectV2ItemStatusChangedEvent`（`previousStatus` / `status` / `actor` / `wasAutomated`）。**ほかのフィールド（Priority・Story Points・Phase・Area・Kind）は値の `updatedAt` / `creator` だけで、前の値は残らない**。timeline の Project v2 のイベントは入れた・外した・Status の 3 種 |
| コメント | なし（`UpdateIssueCommentInput` は `id` / `body`） | なし | あり: `IssueComment.userContentEdits` |
| 新規 Issue・コメントの投稿 | 追記なので衝突しない（二重投稿は A の印で避ける） | — | — |
| 参考: Git のデータ | **あり**: `createCommitOnBranch` の `expectedHeadOid`（必須） | あり | 履歴そのもの |
| GitLab Issue（`PUT /projects/:id/issues/:iid`） | なし（`updated_at` は管理者が時刻を設定する入力で、前提ではない） | なし | ラベル・Milestone・状態・weight・iteration は `resource_*_events`。本文・題の履歴は API の文書で確認できなかった（画面の description history だけ） |
| GitLab ノート | なし | なし | system notes |

GitHub の新しい「issue fields」（`UpdateIssueInput.issueFieldUpdates`、`IssueFieldChangedEvent` の `previousValue` / `newValue`）には、`suggest` / `isSuggestion`（置き換えずに提案として保留し、人が採用する）がある。置き換えない書き方（候補 2）を GitHub 自身が持ち始めた印だが、Project のフィールドとは別の仕組みで、このリポジトリの運用（Project の Priority / Phase …）には無い。

### 候補の比較（#927 の再現に当てて）

| 候補 | 成立する条件 | 反例・成立しないところ | 従来の操作への影響 | 費用・運用 |
|---|---|---|---|---|
| 1. サービス側の条件つき書き込み（CAS・版） | API が期待値を受け、違えば拒むこと。偽 forge の「条件つき」の行がこれ（`between-check-and-write` が `refused`、失う値なし） | **GitHub の Issue・コメント・Project、GitLab の Issue・ノートに無い**（上の表）。あるのは Git のデータ API だけで、バックログを Git のファイルに置く設計は #882 で不採用 | なし | 成立しないので評価しない |
| 1′. 事後の照合（履歴で読み戻す） | 書いたあとに、照合の読みから書き込みまでの間の相手の編集を履歴から読めること。本文・題・状態・ラベル・Milestone・親・Project の Status は読める（表の「履歴」列）。再現: bench の `github` の行で `between-check-and-write` の `recoverable` が `[v2]`（`a.recovers`） | **Status 以外の Project フィールドは履歴が無い** → この対象だけ A の窓が残る（bench の `github-project-field` の行: `lost` が `[v2]` で `recoverable` が空）。**本文・コメント**（`userContentEdits` で読む対象。GitHub の文書の範囲は issues / issue comments / pull requests / review comments / commit comments）の履歴は 1 件あたり 100 版までで、作者と書き込み権限のある人は版の内容を消せる（上の一次資料）。題・状態・ラベル・Milestone・親・Project の Status は timeline のイベントで、文書には押し出しも内容の削除も書かれていない（記載が無いことの確認であり、実現 PBI で実 GitHub でも確かめる）。本文・コメントでは、書いた直後（同じ送信の中）に読んでも、その前に消された版の値は戻らず（bench の `history-deleted`: `recoverable` が空、`traced` が true）、押し出された版は跡も残らない（`history-evicted`: どちらも無い。履歴の無いフィールドと同じ）→ **ここは B の「失わない」が縮む**。履歴の読みそのものが失敗した・読み切れなかった（ページが欠けた）ときも値は戻らず、書いたあとが確かめられていないことしか分からない（`history-unreadable`: `historyRead` が false。下の受け入れ条件 4）。候補は「編集者と時刻だけ分かる版があった」として値なしの `conflict` にすることで、それで足りるかは利用者の判断（下の 4）。同じ秒の編集は `createdAt`（秒）で順序が決まらない → 相手かどうかは `actor` / `editor`（自分のログインでないこと）で見る。同じログインで GitHub の画面から編集したものは区別できない | なし。GitHub 側は今までどおり書ける | 書き込み 1 回につき読み 1 回（`timelineItems(since:)` / `userContentEdits`。GraphQL で数点）。`Sender.set` の直後の読みを「今の値 + 照合の読み以降の履歴」にし、相手の編集があれば `conflict`（相手の値を履歴から添える）。GitHub の値は既に手元の値になっているので、自動では戻さない。**今の競合の扱いを 2 か所変える**（[backlog-sync.md](backlog-sync.md) の「取込みと競合」）: 取込みは「GitHub が手元の値になった `conflict` は done」とするので、事後に見つけた競合（GitHub = 手元の v3）がそのまま閉じられる → この競合は `remote` を履歴の値（v2）にして、取込みで閉じない印が要る。選択の「外部」は今の GitHub の値（v3）を取るので、相手の値に戻す選択は、履歴の値を新しい `set`（base = v3）として送る形にする |
| 2. 置き換えない書き方（追記の提案） | 置き換えでなく追記で表せること。本文・題はコメントで提案して人が採用。GitHub の issue fields と close には `suggest` がある | 状態・ラベル・Milestone・親・Project フィールドは置き換えしかない。採用する人が要るので「回答」の反映が遅れ、自動着手の条件（#888）が動かない | GitHub だけを見る人が提案を自分で反映する手間 | 採用の画面と経路を作る。#882 の「従来の操作を継続」と衝突 |
| 3. 書く経路を 1 本に（集約・排他） | GitHub 側から直接書かない、または両側が守る排他（編集中の印のラベルなど） | GitHub の画面は印を見ない（助言的な排他は守られない）。Switchboard だけが書くのは #882 の「GitHub 側だけで操作する人にも従来の操作を継続」と矛盾 | 大きい | 不採用を推奨 |

### 推奨

**1′（事後の照合）を B の実現方式にし、Status 以外の Project フィールドは A のまま**と明記する。1′ でも履歴から消えた版は戻らないので、B はそのぶん縮む（下の 4 を利用者に聞く）。GitHub の API に条件つき書き込みが無い今、B の「黙って失わない」は、失ったことに気づいて相手の値を添える形でしか満たせない。それができないフィールドは「できない」と表示する（今の `limits` の文言を対象ごとに分ける）。

### 利用者に確認する要件（実現 PBI の `## 判断待ち` にする）

1. Status 以外の Project フィールド（Priority・Story Points・Phase・Area・Kind）は A の窓のまま（上書きしうると表示）でよいか。無くすには候補 3（これらは Switchboard からだけ書く）が要り、従来の操作を制限する
2. 事後に見つけた上書きは、A の競合と同じく保留して相手の値を添え、画面で選ぶ（自動では戻さない）でよいか
3. 同じログインで GitHub の画面から書いた編集は「相手」と区別できない。利用者 1 人の運用ではそれでよいか
4. 本文・コメントに限り、履歴の版が読む前に消された場合は値が戻らず跡だけ残り（bench の `history-deleted`）、100 版を超えて押し出された場合は跡も残らない（`history-evicted`）。題・状態・ラベル・Milestone・親・Status の timeline のイベントには、文書上この場合が無い。前者を「誰かが書いた跡（編集者・時刻）だけを添えた `conflict`」で B の「失わない」を満たしたと数えてよいか。後者は履歴の無いフィールドと同じく A の窓が残る（「上書きしうる」の表示）でよいか

### 実現 PBI へ渡す受け入れ条件の候補（#1329 で実現。上の「実現」）

1. 本文・題・状態・ラベル・Milestone・親・Project Status の `set` で、照合の読みから書き込みまでの間の相手の編集を履歴から見つけ、`conflict`（相手の値を添える）にする（検証: `backlog-race-bench` の `github` forge は履歴を持つので、送信がその履歴を読むようにして `between-check-and-write` が `held` になり `lost` が空になる）
2. 拒まれた書き込み（将来 API が拒めるようになったとき）と事後の照合の `conflict` を `failed` にしない（検証: 同 bench の条件つきの行が `held`）
3. 事後に見つけた `conflict` は `remote` に履歴の値（と編集者・時刻。消された版なら値なし）を持ち、GitHub が手元の値のままの取込みで done にならない。「外部」を選ぶと履歴の値を新しい `set`（base = 今の GitHub の値）として送る（検証: `db.test.ts` の取込みの判定と `backlog-send.test.ts` の選択の再生）
4. 履歴の読みが失敗した・読み切れなかった（ページが欠けた、404 / 403）ときは、値なしの `conflict`（読めなかったと分かる理由つき）にし、done にも `failed` にもしない（検証: bench の `history-unreadable` を、送信が履歴を読むようにした上で `held` にする）
5. Status 以外の Project フィールドと、本文・コメントの押し出された版の `limits` に「履歴が無く、上書きしうる」と対象を名指しして出る（検証: `readStoredIssue` のテスト）
6. 書き込みごとに足す読みは 1 回まで（検証: bench の `calls`）
7. 実 GitHub で 1 回、題の編集を照合と書き込みの間に挟んで `conflict` になることを確かめる（利用者確認: 自分のリポジトリで）

調査の Done は B の実現ではない。#882 の B は、この実現 PBI が Done になるか、利用者が 1〜4 を決めて取り扱いを決めるまで閉じない。
