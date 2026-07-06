```json
{
  "matches": [
    {
      "findingId": "F-0001",
      "rawFindingIds": ["raw-1"],
      "evidence": "同一問題と判断した根拠"
    }
  ],
  "newFindings": [
    {
      "rawFindingIds": ["raw-2"],
      "title": "新規指摘の短い題名",
      "severity": "high"
    }
  ],
  "resolvedFindings": [
    {
      "findingId": "F-0002",
      "rawFindingIds": ["raw-previous-1"],
      "evidence": "解消を確認した根拠"
    }
  ],
  "reopenedFindings": [
    {
      "findingId": "F-0003",
      "rawFindingIds": ["raw-3"],
      "evidence": "再発と判断した根拠"
    }
  ],
  "conflicts": [
    {
      "findingIds": [],
      "rawFindingIds": ["raw-4", "raw-5"],
      "description": "レビュワー間の矛盾"
    }
  ],
  "resolvedConflicts": [
    {
      "conflictId": "C-012345ABCDEF",
      "evidence": "調停済みと判断した根拠"
    }
  ],
  "waivedFindings": [
    {
      "findingId": "F-0003",
      "reason": "公開契約（変更禁止の型定義）が Record を強制しており、hasOwn による遮断が完全な対策であるため",
      "evidence": "src/types.ts:94, src/domain.ts:82"
    }
  ],
  "disputeNotes": [
    {
      "findingId": "F-0004",
      "reason": "coder は仕様起因と主張したが、証跡が該当箇所を示していないため不承認",
      "evidence": "src/store.ts:10"
    }
  ]
}
```
