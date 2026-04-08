# Structured Output — Phase 3 ステータス判定

## 概要

Phase 3（ステータス判定）において、エージェントの出力を structured output（JSON スキーマ）で取得し、ルールマッチングの精度と信頼性を向上させる。

## プロバイダ別の挙動

| プロバイダ | メソッド | 仕組み |
|-----------|---------|--------|
| Claude | `structured_output` | SDK が `StructuredOutput` ツールを自動追加。エージェントがツール経由で `{ step, reason }` を返す |
| Codex | `structured_output` | `TurnOptions.outputSchema` で API レベルの JSON 制約。テキストが JSON になる |
| OpenCode | `structured_output` | プロンプト末尾に JSON スキーマ付き出力指示を注入。テキストレスポンスから `parseStructuredOutput()` で JSON を抽出 |

## フォールバックチェーン

`judgeStatus()` は3段階の独立した LLM 呼び出しでルールをマッチする。

```
Stage 1: structured_output  — outputSchema 付き LLM 呼び出し → structuredOutput.step（1-based integer）
Stage 2: phase3_tag         — outputSchema なし LLM 呼び出し → content 内の [STEP:N] タグ検出
Stage 3: ai_judge           — evaluateCondition() による AI 条件評価
```

各ステージは専用のインストラクションで LLM に問い合わせる。Stage 1 は「ルール番号を JSON で返せ」、Stage 2 は「タグを1行で出力せよ」と聞き方が異なる。

セッションログには `toJudgmentMatchMethod()` で変換された値が記録される。

| 内部メソッド | セッションログ |
|-------------|--------------|
| `structured_output` | `structured_output` |
| `phase3_tag` / `phase1_tag` | `tag_fallback` |
| `ai_judge` / `ai_judge_fallback` | `ai_judge` |

## インストラクション分岐

Phase 3 テンプレート（`perform_phase3_message`）は `structuredOutput` フラグで2つのモードを持つ。

### Structured Output モード（`structuredOutput: true`）

主要指示: ルール番号（1-based）と理由を返せ。
フォールバック指示: structured output が使えない場合はタグを出力せよ。

### タグモード（`structuredOutput: false`）

従来の指示: 対応するタグを1行で出力せよ。

現在、Phase 3 は常に `structuredOutput: true` で実行される。

## アーキテクチャ

```
StatusJudgmentBuilder
  └─ structuredOutput: true
      ├─ criteriaTable: ルール条件テーブル（常に含む）
      ├─ outputList: タグ一覧（フォールバック用に含む）
      └─ テンプレート: "ルール番号と理由を返せ + タグはフォールバック"

runStatusJudgmentPhase()
  └─ judgeStatus() → JudgeStatusResult { ruleIndex, method }
      └─ StatusJudgmentPhaseResult { tag, ruleIndex, method }

StepExecutor
  ├─ Phase 3 あり → judgeStatus の結果を直接使用（method 伝搬）
  └─ Phase 3 なし → detectMatchedRule() で Phase 1 コンテンツから検出
```

## JSON スキーマ

### judgment.json（judgeStatus 用）

```json
{
  "type": "object",
  "properties": {
    "step": { "type": "integer", "description": "Matched rule number (1-based)" },
    "reason": { "type": "string", "description": "Brief justification" }
  },
  "required": ["step", "reason"],
  "additionalProperties": false
}
```

### evaluation.json（evaluateCondition 用）

```json
{
  "type": "object",
  "properties": {
    "matched_index": { "type": "integer" },
    "reason": { "type": "string" }
  },
  "required": ["matched_index", "reason"],
  "additionalProperties": false
}
```

## parseStructuredOutput() — JSON 抽出

Codex と OpenCode はテキストレスポンスから JSON を抽出する。3段階のフォールバック戦略を持つ。

```
1. Direct parse      — テキスト全体が `{` で始まる JSON オブジェクト
2. Code block        — ```json ... ``` または ``` ... ``` 内の JSON
3. Brace extraction  — テキスト内の最初の `{` から最後の `}` までを切り出し
```

## OpenCode 固有の仕組み

OpenCode SDK は `outputFormat` を型定義でサポートしていない。代わりにプロンプト末尾に JSON 出力指示を注入する。

```
---
IMPORTANT: You MUST respond with ONLY a valid JSON object matching this schema. No other text, no markdown code blocks, no explanation.
```json
{ "type": "object", ... }
```
```

エージェントが返すテキストを `parseStructuredOutput()` でパースし、`AgentResponse.structuredOutput` に格納する。

## 注意事項

- OpenAI API（Codex）は `required` に全プロパティを含めないとエラーになる（`additionalProperties: false` 時）
- Codex SDK の `TurnCompletedEvent` には `finalResponse` フィールドがない。structured output は `AgentMessageItem.text` の JSON テキストから `parseStructuredOutput()` でパースする
- Claude SDK は `StructuredOutput` ツール方式のため、インストラクションでタグ出力を強調しすぎるとエージェントがツールを呼ばずタグを出力してしまう
- OpenCode のプロンプト注入方式はモデルの指示従順性に依存する。JSON 以外のテキストが混在する場合は `parseStructuredOutput()` の code block / brace extraction で回収する
