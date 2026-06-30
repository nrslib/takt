# TAKT アーキテクチャ知識

## コア構造

WorkflowEngine は状態機械。step 間の遷移を EventEmitter ベースで管理する。

```
CLI → WorkflowEngine → Runner（4種） → RuleEvaluator → 次の step
```

| Runner | 用途 | 使い分け |
|--------|------|---------|
| StepExecutor | 通常の3フェーズ実行 | デフォルト |
| ParallelRunner | 並列サブステップ | parallel ブロック |
| ArpeggioRunner | データ駆動バッチ処理 | arpeggio ブロック |
| TeamLeaderRunner | タスク分解 → サブエージェント並列 | team_leader ブロック |

各 Runner は排他。1つの step に複数の Runner タイプを指定しない。

### 3フェーズ実行モデル

通常 step は最大3フェーズで実行される。セッションはフェーズ間で維持される。

| フェーズ | 目的 | ツール | 条件 |
|---------|------|--------|------|
| Phase 1 | メイン作業 | step の allowed_tools | 常に |
| Phase 2 | レポート出力 | Write のみ | output_contracts 定義時 |
| Phase 3 | ステータス判定 | なし（判定のみ） | タグベースルール時 |

## ルール評価

RuleEvaluator は5段階フォールバックで遷移先を決定する。先にマッチした方法が優先される。

| 優先度 | 方法 | 対象 |
|--------|------|------|
| 1 | aggregate | parallel 親（all/any） |
| 2 | Phase 3 タグ | `[STEP:N]` 出力 |
| 3 | Phase 1 タグ | `[STEP:N]` 出力（フォールバック） |
| 4 | ai() judge | ai("条件") ルール |
| 5 | AI fallback | 全条件を AI が判定 |

タグが複数出現した場合は**最後のマッチ**が採用される。

### Condition の記法

| 記法 | パース | 正規表現 |
|------|--------|---------|
| `ai("...")` | AI 条件評価 | `AI_CONDITION_REGEX` |
| `all("...")` / `any("...")` | 集約条件 | `AGGREGATE_CONDITION_REGEX` |
| 文字列 | タグまたは AI フォールバック | — |

新しい特殊構文を追加する場合は workflowParser.ts の正規表現と RuleEvaluator の両方を更新する。

## プロバイダー統合

Provider インターフェースで抽象化。具体的な SDK の差異は各プロバイダー内に閉じ込める。

```
Provider.setup(AgentSetup) → ProviderAgent
ProviderAgent.call(prompt, options) → AgentResponse
```

| 基準 | 判定 |
|------|------|
| SDK 固有のエラーハンドリングが Provider 外に漏れている | REJECT |
| AgentResponse.error にエラーを伝播していない | REJECT |
| プロバイダー間でセッションキーが衝突する | REJECT |
| セッションキー形式 `{persona}:{provider}` | OK |

### モデル解決

5段階の優先順位でモデルを解決する。上位が優先。

1. persona_providers のモデル指定
2. step の model フィールド
3. CLI `--model` オーバーライド
4. config.yaml（プロバイダー一致時）
5. プロバイダーデフォルト

## 補助入口の契約

TAKT では workflow 実行経路だけでなく、preview、doctor、workflow summary、validation、report も利用者に見える契約入口である。設定値、provider、model、tool、権限、出力契約を表示・検証する補助入口は、runtime と同じ正規化済み入力、resolver、override 順を使う。

| 基準 | 判定 |
|------|------|
| runtime と preview が別々の入力で provider、model、tool、権限を解決している | REJECT |
| preview に値が表示されるだけで、runtime と同じ override 条件を検証していない | REJECT |
| doctor や validation が正常とする設定が runtime では別条件により失敗する | 警告 |
| runtime と補助入口が同じ正規化済み入力または同じ resolver を共有している | OK |

## 実行資産の消費境界

TAKT の実行資産は、配置場所や名前だけではなく、それを消費する入口で意味が決まる。同じ文字列でも、資産参照、セッション識別子、表示名、直接渡される本文は別契約として扱う。

| 基準 | 判定 |
|------|------|
| 資産参照を解決する入口と、識別子だけを使う入口を同一視している | REJECT |
| 同名の facet を追加しただけで、直接本文を渡す入口にも反映されると扱っている | REJECT |
| workflow 由来の実行資産と機能固有の実行資産が同じ責務名で混在している | 警告 |
| 入口ごとに、どの resolver / loader がどの資産種別を消費するかを確認して配置している | OK |
| 共有すべき本文を、既存の実行資産 loader から読む形に集約している | OK |

### 参照名と識別名

`persona`、`session_key`、`name` のような文字列は、参照名か識別名かで意味が異なる。参照名なら対応する resolver が資産を読み込む。識別名ならセッション、ログ、状態、表示のキーであり、同名ファイルの存在だけでは内容は使われない。新しい資産を追加した場合は、その資産を読む loader と呼び出し元まで追う。

## ファセット組み立て

faceted-prompting モジュールは TAKT 本体に依存しない独立モジュール。

```
compose(facets, options) → ComposedPrompt { systemPrompt, userMessage }
```

| 基準 | 判定 |
|------|------|
| faceted-prompting から TAKT コアへの import | REJECT |
| TAKT コアから faceted-prompting への依存 | OK |
| ファセットパス解決のロジックが faceted-prompting 外にある | 警告 |

### ファセット解決の3層優先順位

プロジェクト `.takt/` → ユーザー `~/.takt/` → ビルトイン `builtins/{lang}/`

同名ファセットは上位が優先。ビルトインのカスタマイズは上位層でオーバーライドする。

## テストパターン

vitest を使用。テストファイルの命名規約で種別を区別する。

| プレフィックス | 種別 | 内容 |
|--------------|------|------|
| なし | ユニットテスト | 個別関数・クラスの検証 |
| `it-` | 統合テスト | ワークフロー実行のシミュレーション |
| `engine-` | エンジンテスト | WorkflowEngine シナリオ検証 |

### Mock プロバイダー

`--provider mock` でテスト用の決定論的レスポンスを返す。シナリオキューで複数ターンのテストを構成する。

```typescript
// NG - テストでリアル API を呼ぶ
const response = await callClaude(prompt)

// OK - Mock プロバイダーでシナリオを設定
setMockScenario([
  { persona: 'coder', status: 'done', content: '[STEP:1]\nDone.' },
  { persona: 'reviewer', status: 'done', content: '[STEP:1]\napproved' },
])
```

### テストの分離

| 基準 | 判定 |
|------|------|
| テスト間でグローバル状態を共有 | REJECT |
| 環境変数をテストセットアップでクリアしていない | 警告 |
| E2E テストで実 API を前提としている | `provider` 指定の config で分離 |

## エラー伝播

プロバイダーエラーは `AgentResponse.error` → セッションログ → コンソール出力の経路で伝播する。

| 基準 | 判定 |
|------|------|
| SDK エラーが空の `blocked` ステータスになる | REJECT |
| エラー詳細がセッションログに記録されない | REJECT |
| エラー時に ABORT 遷移が定義されていない | 警告 |

## セッション管理

エージェントセッションは cwd と provider ごとに保存される。worktree/clone 実行時はセッション再開をスキップする。

通常の Phase 1 応答で `sessionId` が欠落しているだけなら、既存セッションを直ちに破棄する根拠にはならない。既存の resume context を継続してよい経路では、古い sessionId を維持する。

一方、明示的に新しいセッションとして実行した retry/fallback が成功した場合、応答に `sessionId` がなければ古い resumed session を使い続けてはならない。新規実行の結果として sessionId が得られなかったことを保存層へ伝え、古い session を clear または隔離する。

Report Phase は Phase 1 の成果物を読む Phase 2 であり、readonly かつ tool-free の実行契約を持つ。report retry/fallback でも `permissionMode: readonly`、空の tool 許可、provider 能力 override（例: turn 上限）を落としてはならない。

| 基準 | 判定 |
|------|------|
| `cwd !== projectCwd` でセッション再開している | REJECT |
| セッションキーにプロバイダーが含まれない | REJECT（クロスプロバイダー汚染） |
| 継続すべき Phase 間でセッションが切れている | REJECT（コンテキスト喪失） |
| 新規セッション retry 成功後に、古い resumed session を残している | REJECT（意図しない resume） |
| report retry/fallback で readonly、tool-free、能力 override が落ちている | REJECT |
