# supervise — 最終検証 instruction テンプレート

> **用途**: テスト・ビルド実行、全レビュー結果の確認、最終承認
> **使用エージェント**: supervisor, dual-supervisor
> **レポート**: Validation + Summary（フォーマットをテンプレート内に埋め込み）

---

## テンプレート

```
テスト実行、ビルド確認、最終承認を行ってください。

{カスタマイズ: レビュー通過状況 — dual ピースなど全レビュー通過後の場合}
## Previous Reviews Summary
このムーブメントに到達したということは、以下のレビューがすべてAPPROVEされています：
{カスタマイズ: 実際のレビュー一覧}
- AI Review: APPROVED
- Architecture Review: APPROVED

**ピース全体の確認:**
1. 計画（{report:plan.md}）{カスタマイズ: 設計レポートがあれば追加}と実装結果が一致しているか
2. 各レビュームーブメントの指摘が対応されているか
3. 元のタスク目的が達成されているか

**レポートの確認:** Report Directory内の全レポートを読み、
未対応の改善提案がないか確認してください。

**Validation出力契約:**
```markdown
# 最終検証結果

## 結果: APPROVE / REJECT

## 検証サマリー
| 項目 | 状態 | 確認方法 |
|------|------|---------|
| 要求充足 | ✅ | 要求リストと照合 |
| テスト | ✅ | `npm test` (N passed) |
| ビルド | ✅ | `npm run build` 成功 |
| 動作確認 | ✅ | 主要フロー確認 |

## 成果物
- 作成: {作成したファイル}
- 変更: {変更したファイル}

## 未完了項目（REJECTの場合）
| # | 項目 | 理由 |
|---|------|------|
| 1 | {項目} | {理由} |
```

**Summary出力契約（APPROVEの場合のみ）:**
```markdown
# タスク完了サマリー

## タスク
{元の要求を1-2文で}

## 結果
完了

## 変更内容
| 種別 | ファイル | 概要 |
|------|---------|------|
| 作成 | `src/file.ts` | 概要説明 |

## レビュー結果
| レビュー | 結果 |
|---------|------|
{カスタマイズ: ピースのレビュー構成に応じてリスト変更}
| AI Review | APPROVE |
| Architecture | APPROVE |
| Supervisor | APPROVE |

## 確認コマンド
```bash
npm test
npm run build
```
```
```

---

## 典型的な rules

```yaml
rules:
  - condition: すべて問題なし
    next: COMPLETE
  - condition: 要求未達成、テスト失敗、ビルドエラー
    next: plan  # or fix_supervisor
```

---

## レポート設定

```yaml
report:
  - Validation: supervisor-validation.md
  - Summary: summary.md
```

**注意**: レポートファイル名に連番を付けない。
