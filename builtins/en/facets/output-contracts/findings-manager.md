```json
{
  "matches": [
    {
      "findingId": "F-0001",
      "rawFindingIds": ["raw-1"],
      "evidence": "Why this is the same issue"
    }
  ],
  "newFindings": [
    {
      "rawFindingIds": ["raw-2"],
      "title": "Short title for the new finding",
      "severity": "high"
    }
  ],
  "resolvedFindings": [
    {
      "findingId": "F-0002",
      "rawFindingIds": ["raw-previous-1"],
      "evidence": "Evidence that the finding is resolved"
    }
  ],
  "reopenedFindings": [
    {
      "findingId": "F-0003",
      "rawFindingIds": ["raw-3"],
      "evidence": "Evidence that the finding has reappeared"
    }
  ],
  "conflicts": [
    {
      "rawFindingIds": ["raw-4", "raw-5"],
      "description": "Reviewer contradiction"
    }
  ],
  "resolvedConflicts": [
    {
      "conflictId": "C-012345ABCDEF",
      "evidence": "Evidence that the conflict is adjudicated"
    }
  ]
}
```
