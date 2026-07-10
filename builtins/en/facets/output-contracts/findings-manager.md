```json
{
  "rawDecisions": [
    {
      "rawFindingId": "raw-1",
      "decision": "same",
      "findingId": "F-0001",
      "evidence": "src/foo.ts:42 confirms the same issue"
    },
    {
      "rawFindingId": "raw-2",
      "decision": "new",
      "findingId": "",
      "evidence": "No related open finding exists"
    },
    {
      "rawFindingId": "raw-previous-1",
      "decision": "resolved",
      "findingId": "F-0002",
      "evidence": "Verified the fix at src/bar.ts:10"
    },
    {
      "rawFindingId": "raw-3",
      "decision": "reopened",
      "findingId": "F-0003",
      "evidence": "The issue has reappeared"
    },
    {
      "rawFindingId": "raw-4",
      "decision": "conflict",
      "findingId": "F-0005",
      "evidence": "Contradicts the existing resolved status"
    }
  ],
  "disputeDecisions": [
    {
      "findingId": "F-0003",
      "decision": "waive",
      "reason": "The frozen public contract mandates Record and the hasOwn guard is the complete mitigation",
      "evidence": "src/types.ts:94, src/domain.ts:82"
    },
    {
      "findingId": "F-0004",
      "decision": "note",
      "reason": "The coder claimed a spec constraint but the evidence does not point at the location; rejected",
      "evidence": "src/store.ts:10"
    }
  ],
  "conflictDecisions": [
    {
      "conflictId": "C-012345ABCDEF",
      "decision": "resolve",
      "evidence": "Evidence that the conflict is adjudicated"
    }
  ]
}
```

Rules for `rawDecisions`:
- One entry per raw finding listed in the prompt, no more, no fewer.
- `findingId` is required for `same`, `resolved`, `reopened`, and `conflict`; leave it as an empty string for `new`.
- Return only your per-item judgment. Do not assemble the final ledger update (matching, grouping, conflict shape) yourself; the engine does that and enforces the ledger invariants.

Rules for `disputeDecisions` and `conflictDecisions`:
- Leave both arrays empty when there is nothing to adjudicate (no "Disputed Findings" heading in the prior step response, or no active conflict in the ledger).
