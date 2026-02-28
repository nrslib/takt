# TAKT アーキテクチャ知識

## コア構造

PieceEngine は状態機械。movement 間の遷移を EventEmitter ベースで管理する。

```
CLI → PieceEngine → Runner（4種） → RuleEvaluator → 次の movement
```

| Runner | 用途 | 使い分け |
|--------|------|---------|
| MovementExecutor | 通常の3フェーズ実行 | デフォルト |
| ParallelRunner | 並列サブムーブメント | parallel ブロック |
| ArpeggioRunner | データ駆動バッチ処理 | arpeggio ブロック |
| TeamLeaderRunner | タスク分解 → サブエージェント並列 | team_leader ブロック |

各 Runner は排他。1つの movement に複数の Runner タイプを指定しない。

### 3フェーズ実行モデル

通常 movement は最大3フェーズで実行される。セッションはフェーズ間で維持される。

| フェーズ | 目的 | ツール | 条件 |
|---------|------|--------|------|
| Phase 1 | メイン作業 | movement の allowed_tools | 常に |
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

新しい特殊構文を追加する場合は pieceParser.ts の正規表現と RuleEvaluator の両方を更新する。

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
2. movement の model フィールド
3. CLI `--model` オーバーライド
4. config.yaml（プロバイダー一致時）
5. プロバイダーデフォルト

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
| `it-` | 統合テスト | ピース実行のシミュレーション |
| `engine-` | エンジンテスト | PieceEngine シナリオ検証 |

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

エージェントセッションは cwd ごとに保存される。worktree/clone 実行時はセッション再開をスキップする。

| 基準 | 判定 |
|------|------|
| `cwd !== projectCwd` でセッション再開している | REJECT |
| セッションキーにプロバイダーが含まれない | REJECT（クロスプロバイダー汚染） |
| Phase 間でセッションが切れている | REJECT（コンテキスト喪失） |
