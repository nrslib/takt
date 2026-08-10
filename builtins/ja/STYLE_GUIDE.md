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

```
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

```
この内容は…
├── identity・専門性・責任境界 → ペルソナ
├── 原則・禁止事項・finding/edit 権限 → ポリシー
├── 判断材料・選択肢・適用条件 → ナレッジ
├── 探索起点・順序・拡張条件・停止条件 → インストラクション
└── 記録形式 → 出力契約
```

独立して適否を判定する不変条件は1つのポリシーだけを正本にし、他レイヤーでは役割・手順・出力構造だけを記載する。同じ判断規則を複数レイヤーへ言い換えて重複させない。

Phase 1 の共通インストラクションは、注入されたすべての Policy / Knowledge の Source Path を特定し、各正本を先頭から EOF まで読み、各ファセット・セクションを `適用 / 非適用 / 要追加確認` に分類する順序を作業開始手順として持つ。途中で切れる表示は分割して読み続け、別 checkout・スキル・同名ファイルで正本を代替しない。全文確認は判断材料を取りこぼさないために行い、全項目を finding・編集へ変換する権限にはしない。
