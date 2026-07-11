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
  ],
  "invalidateDecisions": [
    {
      "findingId": "F-0012",
      "evidence": "The finding's location does not correspond to any file in the reviewed code; the underlying claim has no basis"
    }
  ],
  "duplicateDecisions": [
    {
      "canonicalFindingId": "F-0011",
      "duplicateFindingIds": ["F-0017", "F-0018"],
      "evidence": "All three describe the same distributed-lock cleanup gap; reviewers used different familyTag values and cited different lines for it"
    }
  ]
}
```

Rules for `rawDecisions`:
- One entry per raw finding listed in the prompt, no more, no fewer.
- `findingId` is required for `same`, `resolved`, `reopened`, and `conflict`; leave it as an empty string for `new` and `unsupported`.
- `unsupported` is for a raw finding that explicitly referenced an existing finding (targetFindingId set) but the reference does not hold up; it creates no finding and changes nothing.
- Return only your per-item judgment. Do not assemble the final ledger update (matching, grouping, conflict shape) yourself; the engine does that and enforces the ledger invariants.
- familyTag and line-number differences are hints, not identity — judge `same` vs `new` by failure mode, trigger, impact, and required fix.

Rules for `disputeDecisions` and `conflictDecisions`:
- Leave both arrays empty when there is nothing to adjudicate (no "Disputed Findings" heading in the prior step response, or no active conflict in the ledger).

Rules for `invalidateDecisions` and `duplicateDecisions`:
- `invalidateDecisions`: only for finding ids the prompt lists as invalidation candidates (the engine already deterministically confirmed their location fails a check). Leave empty when there are no candidates or you disagree with all of them.
- `duplicateDecisions`: for open findings that are the same underlying problem. Leave empty when you find no duplicates among the open findings shown.

Interpretation phase (separate call, when ambiguous raw findings exist):
- The engine may also call you with an "Ambiguous raw finding interpretation" prompt. There you return `interpretations` (one PROPOSAL per ambiguous raw finding): `create_independent`, `same_with_proof` (only with an engine-issued proofId from the prompt), `open_conflict`, or `provisional`.
- You can never resolve, waive, invalidate, supersede, or reopen a finding from that phase; proposals outside your granted capabilities become gate-blocking provisional findings.
