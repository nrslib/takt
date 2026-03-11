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

## 3層プロンプトアーキテクチャ

```
System Prompt:
  [TAKT コンテキスト]
  [ペルソナ]              ← エージェントの identity・専門知識

User Message (Phase 1):
  [実行コンテキスト]
  [Piece Context]
  [User Request]
  [Previous Response]
  [Instructions]          ← ムーブメント固有の手順
    └── [ポリシー]        ← 共有行動規範（instruction 内に含まれる）
```

## 分離の判断フロー

```
この内容は…
├── 特定のエージェントだけが必要 → ペルソナ
├── 「〜すべき」行動規範 → ポリシー
├── 「〜はこう動く」「〜はこういう設計にすべき」ドメイン知識 → ナレッジ
├── ムーブメント固有の手順 → インストラクション
└── エージェント出力の構造定義 → 出力契約
```
