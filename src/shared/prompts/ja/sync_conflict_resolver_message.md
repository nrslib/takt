<!--
  template: sync_conflict_resolver_message
  role: sync コンフリクト解決エージェントのユーザーメッセージ
  vars: originalInstruction
  caller: features/tasks/list/taskSyncAction.ts
-->
Git merge がコンフリクトにより停止しました。

## 手順

### 1. コンフリクト状態を確認する

`git status` を実行して未マージファイルを列挙する。

### 2. コンテキストを把握する

以下を並列で実行:
- `git log --oneline HEAD -5` で HEAD 側の最近の変更を確認
- `git log --oneline MERGE_HEAD -5` で取り込み側の最近の変更を確認（merge の場合）

### 3. 各ファイルを分析する

ファイルごとに以下を実行:
1. ファイル全体を読む（コンフリクトマーカー付きの状態）
2. 各コンフリクトブロック（`<<<<<<<` 〜 `>>>>>>>`）について:
   - HEAD 側の内容を具体的に読む
   - theirs 側の内容を具体的に読む
   - 差分が何を意味するか分析する（バージョン番号？リファクタ？機能追加？）
   - 判断に迷う場合は `git log --oneline -- {file}` で変更履歴を確認する
3. 解決前に判断根拠を記述する

### 4. 解決を実施する

- 片方採用が明確な場合: `git checkout --ours {file}` / `git checkout --theirs {file}`
- 両方の変更を統合する場合: ファイルを編集してコンフリクトマーカーを除去し、両方の内容を結合する
- 解決したファイルを `git add {file}` でマークする

解決後、`<<<<<<<` を検索してマーカーの取り残しがないか確認する。

### 5. 波及影響を確認する

- ビルド・テストが利用可能なら実行する
- コンフリクト対象外のファイルが、解決した変更と矛盾していないか確認する

### 6. マージを完了する

`git commit` を実行して完了する。

## 元のタスク

{{originalInstruction}}
