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
      "rawFindingIds": ["raw-4", "raw-5"],
      "description": "レビュワー間の矛盾"
    }
  ],
  "resolvedConflicts": [
    {
      "conflictId": "C-012345ABCDEF",
      "evidence": "調停済みと判断した根拠"
    }
  ]
}
```
