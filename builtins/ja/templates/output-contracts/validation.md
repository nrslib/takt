# validation — 最終検証レポートテンプレート

> **用途**: supervise ムーブメントの Validation レポート
> **report 設定**: `Validation: supervisor-validation.md`

---

## テンプレート

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
