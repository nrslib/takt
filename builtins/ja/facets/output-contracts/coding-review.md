```markdown
# コーディングレビュー

{{include:output-contracts/base-review-result}}

## サマリー
{1-2文でレビュー結果を要約}

## 契約入口チェック
ID、名前、メタデータ、設定、環境変数、外部出力形式の追加・変更がある場合は記載する。

| 入口・経路 | 元要件 | 実装根拠 | テスト根拠 | 判定 | 例外・未確認の根拠 |
|-----------|--------|----------|------------|------|-------------------|
| {通常入口 / 派生条件 / 検証 / 評価 / 出力 / 再注入など} | {要件} | `src/file.ts:42` | `src/file.test.ts:10` | ✅/❌/⚠️ | {なし / 根拠} |

{{include:output-contracts/base-review-non-finding-concerns}}

## 今回の指摘（new）
| # | finding_id | 重大度 | 場所 | 問題 | 影響 | 根拠 | 修正案 |
|---|------------|--------|------|------|------|------|--------|
| 1 | CODE-NEW-src-file-L42 | High / Medium / Low | `src/file.ts:42` | {問題} | {影響} | {file:line または再現可能な証拠} | {修正案} |

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | CODE-PERSIST-src-file-L77 | `src/file.ts:77` | `src/file.ts:77` | {未解消の問題} | {修正案} |

## 解消済み（resolved）
| finding_id | 元の期待結果 | 解消根拠 |
|------------|--------------|----------|
| CODE-RESOLVED-src-file-L10 | {元 finding の受入条件} | `src/file.ts:10` で解消 |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | CODE-REOPENED-src-file-L55 | 直前の裁定: 解消済み | 修正で再発 | `src/file.ts:55` | {再発した問題} | {修正案} |

{{include:output-contracts/base-review-reopened}}
## 検証証跡
- 差分確認: {確認内容}
- ビルド: {結果。未確認ならその旨}
- テスト: {結果。未確認ならその旨}

{{include:output-contracts/base-review-rescan-evidence}}

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate-only-when}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリー + 検証証跡 + 影響経路の確認証跡と、必要な場合のみ契約入口チェック・非finding化した懸念
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
