## Finding Contract
- Consolidated ledger copy: {{ledgerCopyPath}}
{{#if isReportPhase}}- Use existing finding IDs from the inline ledger summary when referring to tracked findings.
{{else}}- Use existing finding IDs from the ledger when referring to tracked findings.
{{/if}}- Do not assign final finding IDs.

{{#if isReportPhase}}Current finding ledger IDs:
{{else}}Current finding ledger summary:
{{/if}}{{ledgerSummary}}

{{#if isReviewer}}- Report every issue you observe as structured raw findings with kind "issue" (empty targetFindingId).
{{/if}}{{#if reviewerHasOpenFindings}}- Each round, verify the open ledger findings that fall within your review scope.
- When you have confirmed an open finding is fixed, report it as a raw finding with kind "resolution_confirmation", the ledger finding id in targetFindingId, and file:line evidence in description. Findings are only marked resolved through such confirmations.
- Do not re-report an open finding that is still unfixed; report a new issue only if it regressed or changed.
{{/if}}{{#if reviewerHasWaivedFindings}}- Do not re-report findings listed as waived in the ledger summary. If you observe that a waiver premise no longer holds, report that observation as a new issue citing the waived finding id.
{{/if}}{{#if isReviewer}}- Use rawFindingId values that are unique within this response.
- Copy each Observed Findings family_tag value into the structured familyTag field.
- Return structured output matching this raw findings schema:
{{rawFindingsJsonSchema}}
{{/if}}{{#if canDispute}}- Before you act on a finding, check it against the current code. Fix it when it is valid and fixable with the operations you are allowed to perform. If the finding no longer matches reality (already fixed, or it cites structures that no longer exist), or it is valid but cannot be fixed with the operations you are allowed to perform (frozen public contract, external constraint, deliberate trade-off, or a remedy you are forbidden to perform), do NOT loop on it. State a dispute claim in your response under a "## Disputed Findings" heading, one entry per finding:
  - findingId: the ledger finding id
  - reason: why the finding is stale or cannot be fixed
  - evidence: file:line references from the current code backing the reason
- The findings manager adjudicates dispute claims; only accepted claims stop blocking the gate. Critical findings can never be waived.
{{/if}}
