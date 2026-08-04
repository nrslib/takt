Remediate findings using the engine-provided live Finding Contract ledger summary / Finding state as authoritative. A `findings-ledger.json` file, when present, is only an auxiliary snapshot.

**Disputes:**
- Formally dispute a finding under `## Disputed Findings`, with concrete counterevidence and file:line, only when it contradicts the current code or cannot structurally be resolved within this step's responsibility. A dispute awaits adjudication and does not mean resolved or waived
- Do not use transient tool failures, difficulty, or uncertainty as reasons for a dispute
- Cite an "intentional tradeoff" only when existing requirements or a user decision provide evidence for it

**History:** Before starting remediation, understand `persists` / `reopened` trends and the assumptions missing from earlier remediation. Do not use past reports to add or reopen findings that the live state does not target.
{{include:instructions/review-report-history}}

Limit the "unresolved issues" grouped by the following root-cause analysis to open findings whose lifecycle is `new`, `persists`, or `reopened` in this live state.

{{include:instructions/fix-common}}

**Authoritative target:**
- Remediate only open findings whose lifecycle is `new`, `persists`, or `reopened`
- Findings whose status or lifecycle is `resolved` or closed are outside the remediation target
- `findings[].rawFindingIds` provides supporting traceability to raw finding details and individual reviews; it is not an alternative source of truth

**Completion criterion:** Remediate every received open finding or dispute it under `## Disputed Findings` with evidence. Leave no finding with neither outcome.

**Required output (include the headings)**
When any finding is disputed, include `## Disputed Findings` in the format required by the Finding Contract.
{{include:instructions/fix-output-common}}
## Acceptance criteria
| finding ID | Acceptance criterion | Evidence | Status |
|------------|----------------------|----------|--------|
| {ID} | {Expected behavior} | {Test or reproducible verification result} | {Complete / disputed} |
## Evidence
- {Key files, searches, diffs, and logs inspected}
