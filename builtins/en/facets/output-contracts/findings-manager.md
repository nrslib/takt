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
  ],
  "dismissDecisions": [
    {
      "findingId": "F-0021",
      "basis": "out_of_scope",
      "reason": "Demands evidence of quality-gate execution; evaluating verification results is the final gate's jurisdiction, and the claim alleges no code defect"
    }
  ]
}
```

Rules for `rawDecisions`:
- One entry per raw finding listed in the prompt, no more, no fewer.
- Use `reopened` when a previously resolved, waived, or dismissed finding has reappeared.
- `findingId` is required for `same`, `resolved`, `reopened`, and `conflict`; leave it as an empty string for `new` and `unsupported`.
- `unsupported` is for a raw finding that explicitly referenced an existing finding (targetFindingId set) but the reference does not hold up. It creates no confirmed finding and leaves the target unchanged, while the engine retains the raw claim as a gate-blocking provisional.
- Return only your per-item judgment. Do not assemble the final ledger update (matching, grouping, conflict shape) yourself; the engine does that and enforces the ledger invariants.
- familyTag and line-number differences are hints, not identity — judge `same` vs `new` by failure mode, trigger, impact, and required fix.

Rules for `disputeDecisions` and `conflictDecisions`:
- Leave both arrays empty when there is nothing to adjudicate (no "Disputed Findings" heading in the prior step response, or no active conflict in the ledger).

Rules for `invalidateDecisions` and `duplicateDecisions`:
- `invalidateDecisions`: only for finding ids the prompt lists as invalidation candidates (the engine already deterministically confirmed their location fails a check). Leave empty when there are no candidates or you disagree with all of them.
- `duplicateDecisions`: for open findings that are the same underlying problem. Leave empty when you find no duplicates among the open findings shown.

Rules for `dismissDecisions`:
- Only finding ids the prompt lists as dismissal candidates (open provisional findings whose claims cannot be settled mechanically) are eligible. The engine rejects dismissals outside the list.
- `basis` is `out_of_scope` (the claim is outside the finding contract's jurisdiction — for example, demands about verification-result reporting belong to the final gate) or `unverifiable_claim` (the claim can never be substantiated).
- Keep a candidate open (leave it out) when the underlying concern is real and could still be settled by later clean review evidence. A dismissal means "outside adjudication scope", never "fixed", and stays on the ledger with an audit record.
- An engine decision rejection, stale findingId, unsupported decision, or missing decision is not itself grounds for dismissal. Evaluate the raw claim and keep it open when it describes a real code concern.
- Leave empty when there are no candidates or every candidate deserves to stay open.

Interpretation phase (separate call, when ambiguous raw findings exist):
- The engine may also call you with an "Ambiguous raw finding interpretation" prompt. There you return `interpretations` (one PROPOSAL per ambiguous raw finding): `create_independent`, `same_with_proof` (only with an engine-issued proofId from the prompt), `open_conflict`, or `provisional`.
- You can never resolve, waive, invalidate, supersede, or reopen a finding from that phase; proposals outside your granted capabilities become gate-blocking provisional findings.
