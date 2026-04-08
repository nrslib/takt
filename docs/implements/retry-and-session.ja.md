# failed -> retry とセッション再開の動作原理

このドキュメントは、`takt list` の `failed` タスクを `Retry` したときの挙動と、AI セッション再開の実際の仕組みを整理した実装メモです。

## 問題の要約

- `failed -> retry` で「前回のセッションがそのまま復活するか」が分かりづらい。
- 実際には「タスク固有のセッション再開」ではなく「保存済みの persona セッション利用」で再開される。

## 解決方針（実装の見方）

- `Retry` が何を再投入するかを確認する。
- 再実行時にどのセッションIDを読み込むかを確認する。
- `session: refresh` や worktree 条件など、再開しないケースを明記する。

## 実装の流れ

1. `takt list` で `failed` タスクに `Retry` を選ぶ。
2. `retryFailedTask()` が `TaskRunner.requeueFailedTask()` を呼ぶ。
3. 失敗タスク配下の元タスクファイルを `.takt/tasks/` にコピーする。
4. YAML タスクの場合のみ、必要に応じて `start_step` と `retry_note` を書き換える。

参照:
- `src/features/tasks/list/taskRetryActions.ts`
- `src/infra/task/runner.ts`

## 重要: Retry で復元される情報

`requeueFailedTask()` はタスクファイルに `sessionId` を書き戻さない。  
復元対象は `start_step` と `retry_note` のみ。

つまり、`failed` タスクを `Retry` しても「その failed ディレクトリに紐づくセッションID」を直接復元する実装にはなっていない。

## セッション再開の実際

再実行時の `workflowExecution` で、プロジェクト保存済みセッションをロードして `initialSessions` に渡す。

- 通常実行: `loadPersonaSessions(projectCwd, provider)`
- worktree 実行: `loadWorktreeSessions(projectCwd, cwd, provider)`

その後、各 step の Phase 1 実行で `OptionsBuilder.buildAgentOptions()` が `sessionId` を組み立てる。

参照:
- `src/features/tasks/execute/workflowExecution.ts`
- `src/core/workflow/engine/OptionsBuilder.ts`

## セッション再開しない条件

- step 側が `session: refresh` の場合。
- `cwd !== projectCwd` など、セッション再開を抑止する条件に当たる場合。

このため、`Retry` で常に同じ会話が厳密再開されるわけではない。

## 運用上の注意

- `failed -> retry` は正しい復旧手順。
- ただしセッションは「タスク単位」ではなく「persona の保存状態」基準で再開される。
- 前回文脈を確実に残したい場合は、`retry_note` に再試行理由と前提を明記する。
