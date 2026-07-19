## Finding Contract
- Consolidated ledger copy: {{ledgerCopyPath}}
{{#if isReportPhase}}- Use existing finding IDs from the inline ledger summary when referring to tracked findings.
{{else}}- Use existing finding IDs from the ledger when referring to tracked findings.
{{/if}}- Do not assign final finding IDs.

{{#if isReportPhase}}Current finding ledger IDs:
{{else}}Current finding ledger summary:
{{/if}}{{ledgerSummary}}

{{#if isReviewer}}- Report every fresh issue you observe as a structured raw finding with relation "new" (empty targetFindingId). `relation` is the authoritative field; do not emit the legacy `kind` field.
- `new`, `persists`, `resolution_confirmation`, and `reopened` are evidence-backed raw relations with ledger IDs where required. The findings-manager and engine make final lifecycle decisions and finding-ID matches; reviewers must not assign or decide final state.
{{/if}}{{#if reviewerHasOpenFindings}}- Each round, verify the open ledger findings that fall within your review scope.
- When you have confirmed an open finding is fixed, report it as a raw finding with relation "resolution_confirmation", the ledger finding id in targetFindingId, and file:line evidence in description. Findings are only marked resolved through such confirmations.
- Do not re-report an open finding that is still unfixed at the same location. If it is still happening but you're confirming it explicitly (e.g. it moved to a different line, or you want to record that it's still present rather than staying silent), report it with relation "persists" and the ledger finding id in targetFindingId — familyTag and line-number differences from the original report do not matter; cite the finding id. Report a fresh "new" issue only if it actually regressed into a different problem.
{{/if}}{{#if reviewerHasWaivedFindings}}- Do not re-report findings listed as waived in the ledger summary. If you observe that a waiver premise no longer holds, report that observation with relation "reopened" and the waived finding id in targetFindingId.
{{/if}}{{#if isReviewer}}- Use rawFindingId values that are unique within this response.
- Copy each Observed Findings family_tag value into the structured familyTag field. It is a classification/search hint only; it does not determine whether a finding is the same as an existing one.
- Every finding requires evidenceKind. Set it to "source_quote" when you are citing code that actually exists at `location`: verbatimExcerpt must be the EXACT text of those lines, copied character-for-character from the file you read — not retyped from memory, not paraphrased, not translated. The engine byte-compares verbatimExcerpt against the current file content; a quote that does not match exactly is never treated as a confirmed defect (it is isolated for review, not blocked as a finding). Copy this exact value into snapshotId for every source_quote finding, unchanged: {{reviewScopeSnapshotId}}
- Set evidenceKind to "locationless" only when the original requirement or existing public contract makes existence or wiring necessary and you searched every required route. A merely incomplete search, inaccessible source, or missing evidence is unverified, not an issue. You cannot quote absent code; leave location, verbatimExcerpt, and snapshotId empty in that case.
- Do not file demands about quality-gate execution or its evidence (whether build / lint / tests / E2E were run or whether results were reported) as raw issues. Evaluating verification results is the final gate's jurisdiction. File a missing-test finding only when you can pin the untested change with a location and source_quote evidence.
- Return structured output matching this raw findings schema:
{{rawFindingsJsonSchema}}
- A raw issue must be a currently present, observed defect that requires a corrective action. Do not make summaries, approvals, normal confirmations, scope descriptions, unverified-only items, or affirmative statements raw issues. Do not use `approval` or `review-summary` as a familyTag.
- Keep a one-to-one match between every Markdown `## Observed Findings` row and structured issue entry, and between every Markdown `## Resolution Confirmations` row and structured confirmation entry.
- APPROVE means zero structured issues; REJECT means one or more structured issues. If APPROVE has no confirmations either, return `rawFindings: []`. Before responding, self-check that the Markdown and structured issue counts match.
{{/if}}- Ledger entries marked `provisional` are system findings: observations whose meaning could not be determined (contradictory labeling, reviewer output overflow, or an interrupted interpretation). They cannot be fixed by code changes and cannot be disputed; they block the final gate until a later clean review round settles them. Do not attempt to "fix" a provisional finding.
{{#if canDispute}}- Before you act on a finding, check it against the current code. Fix it when it is valid and fixable with the operations you are allowed to perform. If the finding no longer matches reality (already fixed, or it cites structures that no longer exist), or it is valid but cannot be fixed with the operations you are allowed to perform (frozen public contract, external constraint, deliberate trade-off, or a remedy you are forbidden to perform), do NOT loop on it. State a dispute claim in your response under a "## Disputed Findings" heading, one entry per finding:
  - findingId: the ledger finding id
  - reason: why the finding is stale or cannot be fixed
  - evidence: file:line references from the current code backing the reason
- The findings manager adjudicates dispute claims; only accepted claims stop blocking the gate. Critical findings can never be waived.
{{/if}}
