# スタイルガイド

プロンプトアーキテクチャの各レイヤーごとにスタイルガイドを用意している。

| レイヤー | ガイド | 配置先 |
|---------|--------|--------|
| ペルソナ | [PERSONA_STYLE_GUIDE.md](PERSONA_STYLE_GUIDE.md) | system prompt（`{{agentDefinition}}`） |
| ポリシー | [POLICY_STYLE_GUIDE.md](POLICY_STYLE_GUIDE.md) | user message（instruction 内） |
| ナレッジ | [KNOWLEDGE_STYLE_GUIDE.md](KNOWLEDGE_STYLE_GUIDE.md) | user message（instruction 内） |
| インストラクション | [INSTRUCTION_STYLE_GUIDE.md](INSTRUCTION_STYLE_GUIDE.md) | Phase 1 メッセージ（`{{instructions}}`） |
| 出力契約 | [OUTPUT_CONTRACT_STYLE_GUIDE.md](OUTPUT_CONTRACT_STYLE_GUIDE.md) | `report.format` |

## 参照元

`facets/` のファイルを参照元として使う。新規作成時はコピーまたは参照して使う。

```
facets/
├── personas/          # ペルソナ
├── policies/          # ポリシー
├── instructions/      # インストラクション
├── knowledge/         # ナレッジ
└── output-contracts/  # 出力契約
```

## プロンプトアーキテクチャ

```text
System Prompt:
  [TAKT コンテキスト]
  [ペルソナ]              ← エージェントの identity・専門性・責任境界

User Message (Phase 1):
  [実行コンテキスト]
  [Workflow Context]
  [User Request]
  [Previous Response]
  [Instructions]          ← 探索起点・順序・拡張条件・停止条件
    ├── [ポリシー]        ← 原則・禁止事項・finding/edit 権限
    └── [ナレッジ]        ← 判断材料・選択肢・適用条件

Report:
  [出力契約]              ← 記録形式
```

## 分離の判断フロー

```text
この内容は…
├── identity・専門性・責任境界 → ペルソナ
├── 原則・禁止事項・finding/edit 権限 → ポリシー
├── 判断材料・選択肢・適用条件 → ナレッジ
├── 探索起点・順序・拡張条件・停止条件 → インストラクション
└── 記録形式 → 出力契約
```

独立して適否を判定する不変条件は1つのポリシーだけを正本にし、他レイヤーでは役割・手順・出力構造だけを記載する。同じ判断規則を複数レイヤーへ言い換えて重複させない。

## 用語と表現

- 既存の仕様、実装、ファセットで使われている語を、意味を変えずに使う。
- 既存の規則をまとめ直すための独自用語、略語、状態名、分類ラベルを新しく作ってはならない。普通の文章で説明できる内容を、新しい概念名へ置き換えない。
- 出力契約で定義された `Finding` と、ワークフローが分岐に使う既存の値だけは、定義どおりに使う。説明のためだけの状態名や、その別名を追加しない。
- 抽象語を重ねず、具体的な値、実在する処理、観測できる結果を平易に書く。専門用語が必要な場合は、既存の正本で定義された語だけを使う。
- エンジンが自動注入する共通制約を、instruction から `workflow rule`、`Workflow-wide rule`、`shared workflow rules` などの内部機構名で参照しない。必要な手順は実際の操作と適用条件を直接記述し、判断基準はその制約の正本だけに置く。

## 実行時テキストをメタ指示にしない

- エージェントへ渡す本文は、その場で確認できる要求、成果物、コード、値、条件、操作を直接記述する。
- `適用 policy`、`include 済み policy`、`この instruction`、`後続 Phase`、`selector`、`workflow rule`、`共有 facet`など、プロンプトの組成や実行機構を逆引きさせる表現を判断・操作の指示に使わない。
- 別facetの規則が必要なら、必要なstepの`policy`、`knowledge`、`instruction`へworkflow YAMLから明示的に合成する。本文からfacet名や配置を参照させない。
- 状態遷移、再実行条件、初回・後続の区別、提出元の選択、完了・差し戻し条件などworkflow固有の規則はworkflow YAMLへ置く。複数stepへ文章として渡す必要がある規則は`workflows/rules/`へ分離し、`all_steps.rules`の配列で合成する。
- workflow固有の手順を文章として渡す必要がある場合は、汎用instructionへ混ぜず専用instructionへ分離し、`instruction: [汎用手順, 専用手順]`の配列でそのstepだけに合成する。
- workflowの状態や役割によって適用範囲が変わる判断規則は、policyへ置かず`workflows/rules/`へ分離する。workflowと無関係に複数stepで共有できる判断規則だけをpolicyにし、汎用policyと専用policyを混ぜず`policy`配列で合成する。
- `all_steps.rules` は子のworkflow callにも継承される。裁定、修正台帳、最終確認など特定の役割だけが必要とする規則を、その役割を内包する親workflowへ置かない。必要な役割だけを持つ最小のworkflowで合成し、通常のreviewerへ専用schemaや工程語を流入させない。
- エンジンが解釈する正式な状態名・機械値は、その実在する契約として必要な箇所だけに記載する。プロンプト調整のための分類名や言い換えを新しい契約として作らない。
- エンジン内の判定用プロンプトと構造化出力も同じ基準で扱う。コードが分岐・検証・保存に使わない分類値や別名フィールドを、説明や表示のためだけにモデルへ要求しない。
- 要求・コード・利用者の語彙で説明できる内容に新しい呼称を作らない。`family`、`actionable`など既存の正式なレポート項目を扱う場合も、その項目が必要な専用ファセットまたはworkflow ruleだけで使い、汎用ファセットへ概念を広げない。

## 別のステップのファセットは直接参照できない

ファセットは、実行時に自分のステップのプロンプトへ入る文章（自分が include する partial を含む）と、レポートファイルの中身だけを知っている。別のステップで使われるファセット（instruction、出力契約、ポリシー）の見出し・表・ラベルは見えない。ファセットを書くときは次を守る。

- ステップ間で受け渡す情報は、必ずレポートファイルの中身として書く。「◯◯契約の表」ではなく「review-resolution.md に記録された表」のように、ファイル名とその中身で言及する
- 読む側のファセットに「この表があるはず」と書いても、書く側の出力契約にその節がなければ実行時には存在しない。受け渡しを追加するときは、書く側の契約と読む側の指示の両方を必ず揃える
- 同じレポートファイル名を複数のステップが別々の出力契約で書く場合がある（例: review-resolution.md は裁定と最終ゲートの両方が書く）。読む側が期待する節は、そのファイルを書く全部の契約に入れる
- 状態や区別を表す新しいラベルを作らない。平易な言葉で、ファイル名と実在する節の名前だけを使って書く
