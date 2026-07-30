```markdown
# セキュリティレビュー

## 結果: APPROVE / REJECT

## 重大度: None / Low / Medium / High / Critical

## チェック結果
| カテゴリ | 結果 | 備考 |
|---------|------|------|
| インジェクション | ✅ | - |
| 認証・認可 | ✅ | - |
| データ保護 | ✅ | - |
| 依存関係 | ✅ | - |

## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載する。注入された指示が structured output を要求するときだけ、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 検証証跡
- ビルド: {確認対象・確認内容・結果。未確認ならその旨}
- テスト: {確認対象・確認内容・結果。未確認ならその旨}
- 動作確認: {確認対象・確認内容・結果。未確認ならその旨}

## 警告（非ブロッキング）
- {セキュリティに関する推奨事項}

## REJECT判定条件
- ブロッキング脆弱性が1件以上ある場合のみ REJECT 可
```

**認知負荷軽減ルール:**
- 問題なし → チェック表のみ（10行以内）
- 警告のみ → + 簡潔な警告
- 脆弱性あり → + 有効な Finding Contract 形式ですべての脆弱性を記載
