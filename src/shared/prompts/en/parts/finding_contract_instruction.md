## Finding Contract
{{#if isReportPhase}}- Use existing finding IDs from the inline ledger summary when referring to tracked findings.
{{else}}- Use existing finding IDs from the ledger when referring to tracked findings.
{{/if}}- Do not assign final finding IDs.

{{#if isReportPhase}}Current finding ledger IDs:
{{else}}Current finding ledger summary:
{{/if}}{{ledgerSummary}}

{{#if isReviewer}}- Report every fresh issue you observe as a structured raw finding with relation "new" (empty targetFindingId).
- `new`, `persists`, `resolution_confirmation`, and `reopened` are evidence-backed raw relations with ledger IDs where required. The findings-manager and engine make final lifecycle decisions and finding-ID matches; reviewers must not assign or decide final state.
{{/if}}{{#if reviewerHasOpenFindings}}- Each round, verify the open ledger findings that fall within your review scope.
- When you have confirmed an open finding is fixed, report it as a raw finding with relation "resolution_confirmation", the ledger finding id in targetFindingId, and file:line evidence in description. Findings are only marked resolved through such confirmations.
- Every resolution_confirmation must request at least one `file_quote` with one contiguous path/startLine/endLine range and a verbatimExcerpt that exactly matches the complete current text of that range. Do not output snapshotId, runId, proofId, file hashes, query results, or any other verification result; the engine binds and verifies those values.
- Do not re-report an open finding that is still unfixed at the same location. If it is still happening but you're confirming it explicitly (e.g. it moved to a different line, or you want to record that it's still present rather than staying silent), report it with relation "persists" and the ledger finding id in targetFindingId — familyTag and line-number differences from the original report do not matter; cite the finding id. Report a fresh "new" issue only if it actually regressed into a different problem.
{{/if}}{{#if reviewerHasWaivedFindings}}- Do not re-report findings listed as waived in the ledger summary. If you observe that a waiver premise no longer holds, report that observation with relation "reopened" and the waived finding id in targetFindingId.
{{/if}}{{#if reviewerHasDismissedFindings}}- Do not re-report findings listed as dismissed in the ledger summary as new. If you observe that a dismissed finding's premise now holds, report that observation with relation "reopened" and the dismissed finding id in targetFindingId.
{{/if}}{{#if isReviewer}}- Use rawFindingId values that are unique within this response.
- Copy each Observed Findings family_tag value into the structured familyTag field. It is a classification/search hint only; it does not determine whether a finding is the same as an existing one.
- First write the review report. Then extract each structured entry from that report without adding a new claim: `rawExcerpt` must be one exact, unique substring of the report, and `candidate` must be either the lossless structured form of that excerpt or `null` when it cannot be extracted faithfully. Do not invent missing title, description, severity, target, relation, or evidence requests.
- Choose exactly one target kind. Use `code` with binary-sorted unique paths for a defect in existing code; `structure` with explicit review-scope roots and manifest targets for a required repository structure; or `absence` for a required path that should exist but is absent, or an exact UTF-8 literal that should occur under explicit roots but has zero matches. Do not use regex, glob patterns, semantic depth, implicit/default roots, or a generic manifest as proof of the original obligation.
- Request evidence; never claim that you issued or verified it. For a `code` target, request a `file_quote` whose verbatimExcerpt is copied character-for-character from the cited range. For a `structure` target, request `repository_manifest`. For an `absence` target, request both the matching `repository_query` (`path_state` or `exact_literal_search`) and an `authoritative_quote` from the registered task or public declaration that establishes the original obligation. The engine verifies quote existence only; the findings manager separately decides whether that quote is relevant to the claimed obligation.
- If a required path/root was excluded, unreadable, non-UTF-8, capped, unsupported, or otherwise not completely searched, the result is a coverage gap, not zero evidence. Do not turn an incomplete search into an absence claim.
- Do not output proofId, snapshotId, runId, offsets, digests, observed manifest contents, query counts/results, or verification outcomes. Reviewers and the extractor can only request evidence; only the engine issues evidence.
- Do not file demands about quality-gate execution or its evidence (whether build / lint / tests / E2E were run or whether results were reported) as raw issues. Evaluating verification results is the final gate's jurisdiction. File a missing-test finding only when you can identify the untested change with a `code` target and a matching `file_quote` request.
- Return structured output matching this raw findings schema:
{{rawFindingsJsonSchema}}
- A raw issue must be a currently present, observed defect that requires a corrective action. Do not make summaries, approvals, normal confirmations, scope descriptions, unverified-only items, or affirmative statements raw issues. Do not use `approval` or `review-summary` as a familyTag.
- Keep a one-to-one match between every Markdown `## Observed Findings` row and non-null structured candidate, and between every Markdown `## Resolution Confirmations` row and non-null structured confirmation candidate. Each entry's rawExcerpt must bind it back to that exact report text.
- APPROVE means zero structured issues; REJECT means one or more structured issues. If APPROVE has no confirmations either, return `rawFindings: []`. Before responding, self-check that the Markdown and structured issue counts match.
{{/if}}- Ledger entries marked `provisional` are system findings: observations whose meaning could not be determined (contradictory labeling, reviewer output overflow, or an interrupted interpretation). They cannot be fixed by code changes and cannot be disputed; they block the final gate until a later clean review round settles them. Do not attempt to "fix" a provisional finding.
{{#if canDispute}}- Before you act on a finding, check it against the current code. Fix it when it is valid and fixable with the operations you are allowed to perform. If the finding no longer matches reality (already fixed, or it cites structures that no longer exist), or it is valid but cannot be fixed with the operations you are allowed to perform (frozen public contract, external constraint, deliberate trade-off, or a remedy you are forbidden to perform), do NOT loop on it. State a dispute claim in your response under a "## Disputed Findings" heading, one entry per finding:
  - findingId: the ledger finding id
  - reason: why the finding is stale or cannot be fixed
  - evidence: file:line references from the current code backing the reason
- The findings manager adjudicates dispute claims; only accepted claims stop blocking the gate. Critical findings can never be waived.
{{/if}}
