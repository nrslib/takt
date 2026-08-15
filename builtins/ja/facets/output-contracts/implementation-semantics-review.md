```markdown
# 実装意味論レビュー

{{include:output-contracts/base-review-result}}

## サマリー
{1-2文でレビュー結果を要約}

{{include:output-contracts/base-review-non-finding-concerns}}

{{include:output-contracts/base-review-problem-family-completion-sweep}}

## 今回の指摘（new）
| # | finding_id | family_tag | 重大度 | 場所 | 問題 | 壊れる条件 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|---|------------|------------|--------|------|------|-----------|---------------------|------------------------------|--------|
| 1 | SEM-NEW-src-file-L42 | data-structure | High / Medium / Low | `src/file.ts:42` | {問題} | {どんな入力・状態で壊れるか} | {follow-upでは accepted_family_unvisited_consumer / remediation_regression / direct_acceptance_criterion_violation / required_consumer_migration のいずれか。初回は該当なし} | {follow-up findingが初回レビューに含まれなかった独立した証拠。初回は該当なし} | {修正案} |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | SEM-PERSIST-src-file-L77 | derived-state | `src/file.ts:77` | `src/file.ts:77` | {未解消の問題} | {修正案} |

## 解消済み（resolved）
| finding_id | 元の期待結果 | 解消根拠 |
|------------|--------------|----------|
| SEM-RESOLVED-src-file-L10 | {元 finding の受入条件} | `src/file.ts:10` で解消 |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | SEM-REOPENED-src-file-L55 | fail-fast | `review-resolution.md`: 解消済み | d | `src/file.ts:55` | {再発した問題} | {修正案} |

{{include:output-contracts/base-review-reopened}}
## 検証証跡
- 差分確認: {確認内容}
- 判定根拠の実在確認: {引用した file:line を実コードで確認した旨}

## 再走査証跡（2回目以降のレビューで必須）
| 照合した Policy/Knowledge の章 | 差分側の根拠（`file:line` または「該当なし」） |
|-------------------------------|---------------------------------------------|
| {章名} | {根拠} |

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate-only-when}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリー + 検証証跡 + 再走査証跡（2回目以降）と、必要な場合のみ非finding化した懸念
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
