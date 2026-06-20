```markdown
# AI生成コードレビュー

## 結果: APPROVE / REJECT

## サマリー
{1文で結果を要約}

## 検証した項目
| 観点 | 結果 | 備考 |
|------|------|------|
| 仮定の妥当性 | ✅ | - |
| API/ライブラリの実在 | ✅ | - |
| コンテキスト適合 | ✅ | - |
| スコープ | ✅ | - |

期待される `family_tag` 値: `hallucination`, `unvalidated-assumption`, `off-by-one`, `api-mismatch`, `missing-edge-case`, `logic-error`, `scope-creep`.
structured raw findings を要求された場合は、この表の `family_tag` 値を structured output の `familyTag` フィールドへコピーする。

## 観測した指摘
| # | family_tag | カテゴリ | 重大度 | 場所 | 問題 | 修正案 |
|---|------------|---------|--------|------|------|--------|
| 1 | hallucination | 幻覚API | high / medium / low | `src/file.ts:23` | 存在しないメソッド | 実在APIへ置換 |

## REJECT判定条件
- ブロッキング指摘が1件以上ある場合のみ REJECT 可
```

**認知負荷軽減ルール:**
- 問題なし → サマリー + チェック表 + 空の指摘セクション（10行以内）
- 問題あり → 該当セクションのみ行追加（30行以内）
