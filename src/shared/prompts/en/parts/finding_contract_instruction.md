## Finding Contract
{{#if isReportPhase}}- Use existing finding IDs from the inline ledger summary when referring to tracked findings.
{{else}}- Use existing finding IDs from the ledger when referring to tracked findings.
{{/if}}- Do not assign final finding IDs.

{{#if isReportPhase}}Current finding ledger IDs:
{{else}}Current finding ledger summary:
{{/if}}{{ledgerSummary}}

{{#if restatementOnly}}## Restatement requests
This is a restatement-only review. Address only the requests below. Preserve each request's source claim atom and return a complete product claim only when the repository evidence supports every required field. Do not invent missing fields, lifecycle relations, targets, or evidence. Each request may produce at most one `new` claim, and any claim must keep relation `new`, have no targetFindingId or target precondition, and may echo the request's anomaly ID in `reassertsReviewerAnomalyId`.
Read the request's target files in the repository before restating. Derive every path and bounded 1-based line range from the current file contents, not from the request excerpt, and request a `file_quote` for each code target with that path and line range only — do not supply source text or verbatimExcerpt, because the engine reads and byte-matches the actual file. If the current file no longer supports the claim, return no claim for that request.
{{restatementRequestsJson}}
{{/if}}

{{#if isReviewer}}- State a short title and a severity (`critical` / `high` / `medium` / `low`) for every issue. The normalizer cannot manufacture a severity you did not state, so an issue without one cannot be admitted and falls back to restatement. Alternative vocabulary such as "blocking" cannot be extracted as a severity.
{{/if}}{{#if reviewerReportGuidance}}- Write an ordinary Markdown review report. Do not return JSON or structured output.
- State every observed issue and every explicit ledger lifecycle claim separately and explicitly in normal prose. An isolated extractor sees only this final report and does not investigate the repository or infer unstated claims.
- Cite paths and bounded 1-based line ranges when they are available. Do not invent missing locators. A repository-wide or architectural issue remains valid without a line range when the affected structure is clearly identified.
- Do not present approvals, summaries, verification tables, or scope descriptions as issues.
{{/if}}{{#if reviewerHasOpenFindings}}- Each round, verify the open ledger findings that fall within your review scope.
- When explicitly reporting an open finding's lifecycle, state its ledger finding ID and whether it persists, is fixed (`resolution_confirmation`), or has reopened. The findings-manager and engine make the final lifecycle decision.
- Do not refile an unchanged open finding as a new issue. If it remains, identify it as `persists`; if it is fixed, identify it as `resolution_confirmation`; if a closed premise has become true again, identify it as `reopened`.
{{/if}}{{#if reviewerHasWaivedFindings}}- Do not re-report findings listed as waived in the ledger summary. If you observe that a waiver premise no longer holds, report that observation with relation "reopened" and the waived finding id in targetFindingId.
{{/if}}{{#if reviewerHasDismissedFindings}}- Do not re-report findings listed as dismissed in the ledger summary as new. If you observe that a dismissed finding's premise now holds, report that observation with relation "reopened" and the dismissed finding id in targetFindingId.
{{/if}}{{#if reviewerReportGuidance}}- The normalizer extracts only claims that you state explicitly in this report. Preserve uncertainty in your prose instead of manufacturing evidence, locations, severity, or lifecycle relations.
- A current defect that requires corrective action is a review issue even when it is architectural, repository-wide, or has no meaningful single-line location.
{{/if}}{{#if provisionalGuidance}}- Ledger entries marked `provisional` are system findings: observations whose meaning could not be determined (contradictory labeling, reviewer output overflow, or an interrupted interpretation). They cannot be fixed by code changes and cannot be disputed; they block the final gate until a later clean review round settles them. Do not attempt to "fix" a provisional finding.
{{/if}}{{#if canDispute}}- Before you act on a finding, check it against the current code. Fix it when it is valid and fixable with the operations you are allowed to perform. If the finding no longer matches reality (already fixed, or it cites structures that no longer exist), or it is valid but cannot be fixed with the operations you are allowed to perform (frozen public contract, external constraint, deliberate trade-off, or a remedy you are forbidden to perform), do NOT loop on it. State a dispute claim in your response under a "## Disputed Findings" heading, one entry per finding:
  - findingId: the ledger finding id
  - reason: why the finding is stale or cannot be fixed
  - evidence: file:line references from the current code backing the reason
- The findings manager adjudicates dispute claims; only accepted claims stop blocking the gate. Critical findings can never be waived.
{{/if}}
