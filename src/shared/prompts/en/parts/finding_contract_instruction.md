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

{{#unless restatementOnly}}{{#if structuredReviewer}}- Report every fresh issue you observe as a structured raw finding with relation "new" (empty targetFindingId).
- `new`, `persists`, `resolution_confirmation`, and `reopened` are evidence-backed raw relations with ledger IDs where required. The findings-manager and engine make final lifecycle decisions and finding-ID matches; reviewers must not assign or decide final state.
{{/if}}{{#if plainTextNormalizedReviewer}}- Write an ordinary Markdown review report. Do not return JSON or structured output.
- State every observed issue and every explicit ledger lifecycle claim separately and explicitly in normal prose. An isolated extractor sees only this final report and does not investigate the repository or infer unstated claims.
- Cite paths and bounded 1-based line ranges when they are available. Do not invent missing locators. A repository-wide or architectural issue remains valid without a line range when the affected structure is clearly identified.
- State a short title and a severity (`critical` / `high` / `medium` / `low`) for every issue. The normalizer cannot manufacture a severity you did not state, so an issue without one cannot be admitted and falls back to restatement. Alternative vocabulary such as "blocking" cannot be extracted as a severity.
- Do not present approvals, summaries, verification tables, or scope descriptions as issues.
{{/if}}{{#if reviewerHasOpenFindings}}- Each round, verify the open ledger findings that fall within your review scope.
{{/if}}{{#if structuredReviewerHasOpenFindings}}- When you have confirmed an open finding is fixed, emit one structured raw finding with relation `resolution_confirmation` and exactly that ledger ID in `targetFindingIds`. Findings are only marked resolved through such confirmations.
- Request evidence through the structured raw finding fields. A code confirmation needs `file_quote`, a structure confirmation needs `repository_manifest`, and an absence confirmation needs `repository_query` plus `authoritative_quote`. Do not output snapshotId, runId, proofId, file hashes, query results, or any other verification result; the engine binds and verifies those values.
- Do not re-report an open finding that is still unfixed at the same location. If it is still happening but you are confirming it explicitly, emit one structured raw finding with relation `persists` and exactly that ledger ID in `targetFindingIds`. Report a fresh `new` issue only if it actually regressed into a different problem.
{{/if}}{{#if plainTextNormalizedReviewerHasOpenFindings}}- When explicitly reporting an open finding's lifecycle, state its ledger finding ID and whether it persists, is fixed (`resolution_confirmation`), or has reopened. The findings-manager and engine make the final lifecycle decision.
- Do not refile an unchanged open finding as a new issue. If it remains, identify it as `persists`; if it is fixed, identify it as `resolution_confirmation`; if a closed premise has become true again, identify it as `reopened`.
{{/if}}{{#if reviewerHasWaivedFindings}}- Do not re-report findings listed as waived in the ledger summary. If you observe that a waiver premise no longer holds, report that observation with relation "reopened" and the waived finding id in targetFindingId.
{{/if}}{{#if reviewerHasDismissedFindings}}- Do not re-report findings listed as dismissed in the ledger summary as new. If you observe that a dismissed finding's premise now holds, report that observation with relation "reopened" and the dismissed finding id in targetFindingId.
{{/if}}{{#if structuredReviewer}}- Use rawFindingId values that are unique within this response.
- First write the review report. Then extract each structured entry from that report without adding a new claim: `rawExcerpt` must be the exact, unique report passage that states the whole issue or lifecycle claim, and `candidate` must be either the lossless structured form of that excerpt or `null` when it cannot be extracted faithfully. Do not invent missing title, description, severity, target, relation, or evidence requests.
- State a short title and a severity (`critical` / `high` / `medium` / `low`) in the report body for every issue claim. Severity is required for product admission and must not be invented during extraction, so a claim whose body states no severity cannot be admitted and falls back to restatement. Alternative vocabulary such as "blocking" cannot be extracted as a severity.
- Choose exactly one target kind. Use `code` with binary-sorted unique paths for a defect in existing code; `structure` with explicit review-scope roots and manifest targets for a required repository structure; or `absence` for a required path that should exist but is absent, or an exact UTF-8 literal that should occur under explicit roots but has zero matches. Do not use regex, glob patterns, semantic depth, implicit/default roots, or a generic manifest as proof of the original obligation.
- Request evidence; never claim that you issued or verified it. For a `code` target, request a `file_quote` with its path and bounded 1-based startLine/endLine only; do not provide source text or verbatimExcerpt. For a `structure` target, request `repository_manifest`. For an `absence` target, request both the matching `repository_query` (`path_state` or `exact_literal_search`) and an `authoritative_quote` from the registered task or public declaration that establishes the original obligation. The engine verifies quote existence only; the findings manager separately decides whether that quote is relevant to the claimed obligation.
- If a required path/root was excluded, unreadable, non-UTF-8, capped, unsupported, or otherwise not completely searched, the result is a coverage gap, not zero evidence. Do not turn an incomplete search into an absence claim.
- Do not output proofId, snapshotId, runId, offsets, digests, observed manifest contents, query counts/results, or verification outcomes. Reviewers and the extractor can only request evidence; only the engine issues evidence.
- Do not file demands about quality-gate execution or its evidence (whether build / lint / tests / E2E were run or whether results were reported) as raw issues. Evaluating verification results is the final gate's jurisdiction. File a missing-test finding only when you can identify the untested change with a `code` target and a matching `file_quote` request.
- Return structured output matching this raw findings schema:
{{rawFindingsJsonSchema}}
- A raw issue must be a currently present, observed defect that requires a corrective action. Do not make summaries, approvals, normal confirmations, scope descriptions, unverified-only items, or affirmative statements raw issues. Do not use `approval` or `review-summary` as a familyTag.
- Keep a one-to-one ordered match between every reported issue or lifecycle claim and structured item.
- APPROVE means zero structured defect claims; REJECT means one or more structured defect claims. If APPROVE has no lifecycle claims either, return `rawFindings: []`. Before responding, self-check that report claims and structured items have a one-to-one ordered match.
{{/if}}{{#if plainTextNormalizedReviewer}}- The normalizer extracts only claims that you state explicitly in this report. Preserve uncertainty in your prose instead of manufacturing evidence, locations, severity, or lifecycle relations.
- A current defect that requires corrective action is a review issue even when it is architectural, repository-wide, or has no meaningful single-line location.
{{/if}}- Ledger entries marked `provisional` are system findings: observations whose meaning could not be determined (contradictory labeling, reviewer output overflow, or an interrupted interpretation). They cannot be fixed by code changes and cannot be disputed; they block the final gate until a later clean review round settles them. Do not attempt to "fix" a provisional finding.
{{#if canDispute}}- Before you act on a finding, check it against the current code. Fix it when it is valid and fixable with the operations you are allowed to perform. If the finding no longer matches reality (already fixed, or it cites structures that no longer exist), or it is valid but cannot be fixed with the operations you are allowed to perform (frozen public contract, external constraint, deliberate trade-off, or a remedy you are forbidden to perform), do NOT loop on it. State a dispute claim in your response under a "## Disputed Findings" heading, one entry per finding:
  - findingId: the ledger finding id
  - reason: why the finding is stale or cannot be fixed
  - evidence: file:line references from the current code backing the reason
- The findings manager adjudicates dispute claims; only accepted claims stop blocking the gate. Critical findings can never be waived.
{{/if}}
{{/unless}}
