# Review Policy

Define the shared judgment criteria and behavioral principles for all reviewers.

## Premise

This review is a defensive quality and security audit performed, on request, against a codebase provided as the review target. All reproduction and verification of vulnerabilities or defects is performed as self-tests within the target repository; applying techniques against third-party systems or developing attack tooling is not part of the purpose.

## Principles

| Principle | Criteria |
|-----------|----------|
| Fix immediately | Never defer minor issues to "the next task." Fix now what can be fixed now |
| Eliminate ambiguity | Vague feedback like "clean this up a bit" is prohibited. Specify file, line, and proposed fix |
| Fact-check | Verify against actual code before raising issues. Do not speculate |
| Practical fixes | Propose implementable solutions, not theoretical ideals |
| State consistency | For side effects and state changes, verify that success, failure, and interruption paths have no missing, duplicated, or inconsistent effects |
| Contract coverage | Verify new contracts across normal entries, derived conditions, validation, evaluation, output, and re-injection paths |
| Contract consistency | Verify that contracts carried by consolidation or abstraction are applied to existing equivalent branches by the same standard |
| Semantic contract | For meaningful fields such as IDs, source, trace, and issue/PR numbers, verify not only the storage shape but also the meaning interpreted downstream |
| External contract verification | Verify semantic contracts of external services, SDKs, and generated artifacts from primary evidence or actual types |
| Specification completeness | When changing a user-facing contract, verify that implementation, tests, and documentation describe the same lookup order, override rules, special syntax, and failure conditions |
| Requirement anchoring | Do not reinterpret required task items as optional, out of scope, or different requirements for implementation convenience |
| Resolution judgment | Judge `resolved` against the original finding acceptance criteria and original task requirements, not merely against the presence of a fix |
| Defect-class re-scan | Before recognizing a defect as resolved, re-scan every path in the same defect class for the original acceptance criteria |
| Concern handling | Any concern recognized in the prose must either become a finding or be explicitly classified with evidence as non-finding |
| Behavior evidence | Verify what behavior the tests or logs prove, not merely that they exist |
| Boy Scout | Have problems fixed within the task scope when they are in changed code or in areas directly affecting correctness, contracts, or wiring of the change |

## Finding Decision Invariants

| Situation | Treatment |
|-----------|-----------|
| A current defect is verified in code or evidence and requires correction | Report it as an issue |
| Evidence is insufficient, the search scope is incomplete, or the result cannot be verified | Record it as unverified scope, not as an issue |
| Claiming absence or missing wiring | Report a locationless issue only when the original requirement or existing public contract makes existence or wiring necessary and every required route was searched |
| Questioning whether quality gates were run or their evidence was reported | Not an issue. Evaluating verification results is the final gate's jurisdiction |

- APPROVE means zero issues and REJECT means one or more issues. Never pad issues with approvals, summaries, or normal confirmations.

## Scope Determination

| Situation | Verdict | Action |
|-----------|---------|--------|
| Problem introduced by this change | Blocking | REJECT |
| Code made unused by this change (arguments, imports, variables, functions) | Blocking | REJECT (change-induced problem) |
| Existing problem in changed or directly related code | Blocking | REJECT (Boy Scout rule) |
| Existing ambiguous or incorrect contract exposed through a new public entry, adapter, or tool | Blocking | REJECT (existing behavior is not an exemption) |
| Structural problem directly affecting correctness of the change | Blocking | REJECT if within scope |
| Problem in an unchanged file | Non-blocking | Record only (informational) |
| Existing problem that merely shares a changed file but does not directly affect correctness of the change | Non-blocking | Record only (informational) |
| Refactoring that greatly exceeds task scope | Non-blocking | Note as a suggestion |

## Judgment Criteria

### REJECT (Request Changes)

REJECT without exception if any of the following apply.

- New behavior without tests
- Boundary changes (permissions, rejection paths, external execution, shared state, state transitions) without verification of the main allow/deny, success/failure, isolation/release behavior
- Bug fix without a regression test
- Use of `any` type
- Fallback value abuse (`?? 'unknown'`)
- Explanatory comments (What/How comments)
- Unused code ("just in case" code)
- Direct mutation of caller-owned, shared, or externally exposed objects/arrays
- Swallowed errors (empty catch blocks)
- TODO/FIXME without an issue number, external blocker, and removal condition
- Essentially identical logic duplicated (DRY violation)
- Method proliferation doing the same thing (should be absorbed by configuration differences)
- Specific implementation leaking into generic layers (imports and branching for specific implementations in generic layers)
- Internal implementation exported from public API (infrastructure functions or internal classes exposed publicly)
- Replaced code/exports surviving after refactoring
- Missing cross-validation of related fields (invariants of semantically coupled config values left unverified)
- Missing caller, producer, consumer, validator, test data, or derived-entry updates after a contract change
- Meaningful fields such as IDs, source, trace, or issue/PR numbers are added, forwarded, or persisted while only the storage shape is checked, without verifying downstream interpretation or confusion with existing fields
- User-facing contract changes for configuration, CLI, or file formats where documentation or examples omit priority, first-match/merge behavior, inline overrides, scoped/special references, or failure conditions
- Existing branches with the same contract remain on the old implementation after adding or changing a shared helper, normalizer, builder, or adapter
- A new public entry, adapter, or tool republishes an existing ambiguous or incorrect contract as an external contract
- Fields, attributes, outputs, settings, or identifiers requested by the task are treated as optional, unset, out of scope, or missing for some entry point or execution mode without explicit evidence
- Operation-specific error types, statuses, return values, or idempotency of an external service, SDK, or generated artifact are not verified, and another operation's contract or mock success is used instead
- Missing, duplicated, or incorrectly ordered effects in side-effect or state-change paths
- Sensitive data exposed in logs, error responses, or test output
- Review prose recognizes a contract mismatch, side effect, boundary value, or unverified risk but does not turn it into a finding and does not classify it as a non-finding with evidence

A DRY finding is not complete unless the proposed consolidation target is also sound. A consolidation proposal is invalid unless all of the following hold.

- The consolidation target matches existing responsibility boundaries and dependency direction
- Any new public API, wrapper, or helper does not expand the existing contract unnaturally
- If the proposal introduces abstraction not required by the task or plan, its necessity is explained with evidence

### Warning

Not blocking, but improvement is recommended.

- Insufficient edge case / boundary value tests
- Tests coupled to implementation details
- Overly complex functions/files
- Naming diverges from reality
- TODO/FIXME with issue number, external blocker, and removal condition
- `@ts-ignore` or `eslint-disable` without justification

### APPROVE

Approve when all REJECT criteria are cleared and quality standards are met. Never give conditional approval. If there are problems, reject.

## Judging Behavior Evidence

Checks that only inspect configuration values, logs, snapshots, or the last observed state are supplementary evidence. They do not prove primary behaviors such as rejection, permission, isolation, or release.

| Evidence | Judgment |
|----------|----------|
| Expected behavior is observed in execution results | OK |
| Deterministic tests cover the main boundary conditions | OK |
| Only external-environment E2E exists, with no reproducible verification of the main boundary | Warning or REJECT |
| Behavior is approved from configuration values, logs, or snapshots only | REJECT |

### Division of Verification Responsibility

Verifying that the full test suite passes is not the reviewer's responsibility. The fixing step's quality gates cover verification of the changed scope (whatever gates are imposed on it, such as the build, static checks, and changed-scope tests); the final gate immediately before merge covers the full suite. Reviewers do not re-run the full suite and instead spend that time reproducing findings and running risk-based targeted checks.

| Evidence | Judgment |
|----------|----------|
| Reproduced your own behavioral finding by operating on or executing the target code | OK (required for behavioral findings) |
| Verified a statically determinable finding (types, contracts, specs, non-executable assets) by reading and cross-checking the relevant sources | OK |
| Verified the main changed behaviors with targeted execution or tests | OK (recommended) |
| Referenced the execution records of all quality gates imposed on the fixing step | OK (no re-run needed) |
| Closing an individual finding based solely on full-suite passage | REJECT |
| A behavioral claim not reproduced or verified by execution | REJECT |

Even when the fixing step's execution records lack evidence for one of its imposed quality gates, do not file that as an issue — evaluating verification results is the final gate's jurisdiction, and a missing-evidence claim would only sit on the completion gate as a mechanically unverifiable provisional. Record the missing evidence as unverified scope, and treat behavioral claims in that scope as not reproduced by execution. Full-suite evidence is the final gate's responsibility, so do not demand it from the fixing step.

Exception: when suite execution is imposed on your own step as a quality gate (the final-gate role), follow the gate's instructions and run it. This section governs reviewers without such gates not spending time on the full suite; it does not exempt an imposed gate.

## Fact-Checking

Always verify facts before raising an issue.

| Do | Do Not |
|----|--------|
| Open the file and check actual code | Assume "it should be fixed already" |
| Search for call sites and usages | Raise issues based on memory |
| Cross-reference type definitions and schemas | Guess that code is dead |
| Distinguish generated files (reports, etc.) from source | Review generated files as if they were source code |
| Verify tool output is readable and uncorrupted | Raise issues based on garbled or abnormal output |
| When claiming code is absent, read the target lines directly | Conclude "code doesn't exist" based on search results alone |

### Tool Output Reliability

If tool output is unreadable, re-read using a reliable method before making any judgment.

| Situation | Action |
|-----------|--------|
| Output contains garbled text or encoding anomalies | Recognize the corruption, then re-read using an alternative method (open the file directly, specify line numbers for the target section) before judging |
| Search command did not find the target code | Read the specific lines of the file directly to confirm absence before raising an issue. Search failure does not equal code absence |
| Re-raising a prior finding without re-checking actual code | Must read current code before marking as persists. Do not re-raise from memory of the prior review |
| A verification task did not actually run the target work due to caching, skipping, or missing configuration | Do not count it as passing evidence. Record what was actually executed separately from what remains unverified |

## Writing Specific Feedback

Every issue raised must include the following.

When one new problem is found, search the review scope for all locations that may share the same `family_tag` before finalizing the report, and report them in the same review. Do not report one location at a time and reveal another location from the same family only after the first is fixed.

When the same kind of problem appears in multiple locations, report one representative finding and list the other locations inline as `also: src/store.ts:L232, src/projection.ts:L243`. Do not spend rows enumerating the same kind of issue; use the remaining attention to hunt different kinds of problems. Do not merge, however, in these cases:

- Findings already tracked under separate `finding_id`s (do not break the tracking unit)
- When a Finding Contract is in use (report every observed problem as an individual raw finding; deduplication is the responsibility of the findings-manager and the ledger)

- **Which file and line number**
- **What the problem is**
- **How to fix it**
- **If requesting abstraction or consolidation, why that placement is the natural one**

```
❌ "Review the structure"
❌ "Clean this up a bit"
❌ "Refactoring is needed"

✅ "src/auth/service.ts:45 — validateUser() is duplicated in 3 places.
     Extract into a shared function."
```

## Finding ID Tracking (`finding_id`)

To prevent circular rejections, track findings by ID.

Finding Contract applies to the whole review workflow, not to individual findings.
Treat a workflow as using Finding Contract only when it is declared at workflow level
with `finding_contract` configuration. A `findings-ledger.json` file, a dedicated
"Finding Contract" section in the instruction template, or an `Observed Findings`
table in the output contract is supporting evidence inside an already configured
Finding Contract workflow; none of these artifacts enables Finding Contract by itself.

When Finding Contract is in use, reviewers must not allocate new final `finding_id`
values or decide final lifecycle state. Report observed problems as evidence-backed
raw findings in the `Observed Findings` table. Use only the raw relations `new`,
`persists`, `resolution_confirmation`, and `reopened`; refer to existing IDs only
when they are present in the ledger. Final lifecycle decisions and finding-ID matching
belong to the findings-manager and engine.

When a workflow is configured with Finding Contract and a parseable ledger is available,
the ledger is the authoritative source for tracked findings. Individual reports and raw
finding details are supporting evidence. If a ledger exists but is incomplete, follow
mapped findings from the ledger and treat unmapped raw findings as potential new entries
pending findings-manager reconciliation. If no parseable ledger is available in a
configured Finding Contract workflow, use report history only as supporting evidence for
observed raw findings. Do not assign final `finding_id` values or lifecycle states and
do not apply the legacy rules; wait for ledger regeneration or findings-manager
reconciliation.

### Legacy Finding ID Rules (for workflows without Finding Contract)

When a workflow does not use `finding_contract` configuration, follow these legacy rules.
This section and the following reopen and immutable-meaning rules do not apply to Finding
Contract workflows. When a recurrence is a different problem under Finding Contract, the
reviewer reports raw relation `new` and does not issue a final `finding_id`; the
findings-manager and engine decide the final ID and lifecycle.

- Every issue raised in a REJECT must include a `finding_id`
- If the same issue is raised again, reuse the same `finding_id`
- For repeated issues, set status to `persists` and include concrete evidence (file/line) that it remains unresolved
- New issues must use status `new`
- Resolved issues must be listed with status `resolved`
- Issues without `finding_id` are invalid (cannot be used as rejection grounds). This legacy rule does not apply to Finding Contract workflows.
- REJECT is allowed only when there is at least one `new` or `persists` issue
- Before treating a prior finding as resolved, verify that the fix did not introduce a different structural or contract problem

### Reopen Conditions (`resolved` -> open)

Reopening a resolved finding requires reproducible evidence.

- To reopen a previously `resolved` finding, all of the following are required  
  1. Reproduction steps (command/input)  
  2. Expected result vs. actual result  
  3. Failing file/line evidence
- If any of the three is missing, the reopen attempt is invalid (cannot be used as REJECT grounds)
- If reproduction conditions changed, treat it as a different problem and issue a new `finding_id`

### Immutable Meaning of `finding_id`

Do not mix different problems under the same ID.

- A `finding_id` must refer to one and only one problem
- If problem meaning, evidence files, or reproduction conditions change, issue a new `finding_id`
- Rewriting an existing `finding_id` to represent a different problem is prohibited

## Handling Test File Size and Duplication

Test file length and duplication are warning-level maintainability concerns by default.

- Excessive test file length and duplicated test setup are `Warning` by default
- They may be `REJECT` only when reproducible harm is shown  
  - flaky behavior  
  - false positives/false negatives  
  - inability to detect regressions
- "Too long" or "duplicated" alone is not sufficient for `REJECT`

## Handling Changelog and History Files

Files or sections that record point-in-time facts (e.g., `CHANGELOG.md`, `RELEASE_NOTES.md`, `MIGRATION.md`) are history, not specifications of the current code. Judge them by their correctness as history.

| Target | Judgment |
|--------|----------|
| Past entry's config keys, API names, or behaviors do not match current code | REJECT prohibited |
| Records that were correct at the time of the relevant release | Modification requests prohibited |
| Factual errors in newly added entries (relative to the target release) | REJECT allowed |
| Markdown formatting issues, duplication, broken links, obvious typos | REJECT or Warning allowed |

### Judgment Criteria

- History records "what changed at that point in time," not "how the system currently works"
- Even if names or behaviors have been changed in current code, that is not grounds to rewrite past entries
- To request modification of a past entry, demonstrate that it was incorrect even at the relevant release point
- Identify history files/sections by file name (`CHANGELOG.md`, etc.) or conventional headings (`### Changed`, `### Added`, dated release headings)
- Do not REJECT a history file or section based solely on disagreement with current schema or current config keys

## Boy Scout Rule

Leave it better than you found it.

### In Scope

- Existing problems in changed code or in areas directly affecting correctness, contracts, or wiring of the change (unused code, poor naming, broken abstractions)
- Structural problems directly affecting correctness of the change (mixed responsibilities, unnecessary dependencies)

### Out of Scope

- Unchanged files (record existing issues only)
- Existing problems that merely share a changed file but do not directly affect correctness, contracts, or wiring of the change
- Refactoring that greatly exceeds task scope (note as a suggestion, non-blocking)

### Judgment

| Situation | Verdict |
|-----------|---------|
| Changed or directly related code has an obvious problem | REJECT — have it fixed together |
| Redundant expression (a shorter equivalent exists) | REJECT |
| Unnecessary branch/condition (unreachable or always the same result) | REJECT |
| Fixable in seconds to minutes | REJECT (do not mark as "non-blocking") |
| Code made unused as a result of the change (arguments, imports, etc.) | REJECT — change-induced, not an "existing problem" |
| Fix requires refactoring (large scope) | Record only (technical debt) |

Do not tolerate problems just because existing code does the same. If existing code is bad, improve it rather than match it.

## Judgment Rules

- Issues detected in changed code or in areas directly affecting correctness, contracts, or wiring of the change are blocking (REJECT targets), even if the code existed before the change
- Only issues not directly related to the change may be classified as "existing problems" or "non-blocking"
- "The code itself existed before" is not a valid reason for non-blocking when the issue is in changed or directly related code
- "Same as existing behavior" is not an approval reason when a new public entry, adapter, or tool exposes that contract
- When a concern mentioned in prose is not made a finding, classify it as `false_positive` / `overreach` / `out_of_scope` / `no_issue_after_verification` and provide evidence
- If even one issue exists, REJECT. "APPROVE with warnings" or "APPROVE with suggestions" is prohibited

## Basic Review Procedure

Common procedure that every reviewer must follow. Do not duplicate this in individual instructions.

### Diff Baseline (Anchor to the Base)

The review target is the entire cumulative diff from the task's starting point (the base), not just the changes from the most recent iteration.

- In the fix ↔ review loop, keep recomputing the diff from the base. Do not move the baseline to the latest fix
- The base is the merge-base with the integration branch, or the starting point recorded in `plan` / `order`. Do not treat only the "changes" section of `Previous Response` as the diff
- On the first review, evaluate the entire cumulative diff and exhaust all locations in each detected finding family
- On the second and later reviews, prioritize prior open findings, their fixes, and directly affected paths. Apply every Policy / Knowledge criterion in that scope, but do not restart broad discovery from scratch in untouched areas of the cumulative diff
- On the second and later reviews, if the focused scope has no blocking finding and the reviewer would return APPROVE, first perform a final review of the entire cumulative diff and reconcile every remaining area and contract
- Unrequested changes introduced in earlier iterations (unrelated comment deletions, renames, reformatting, contract changes, weakened tests, environment-dependent tool-generated diffs — version stamps, re-serialization, order-only rewrites) remain in the cumulative diff even when they no longer appear in the latest fix report. Reconcile them on the first and final reviews and confirm their causal link to the request
- Track finding states (new / persists / resolved) on a fixed baseline. Do not narrow the diff scope and conclude "it is no longer in the diff"

### Referring to Primary Sources

- Use `order.md`, `plan.md`, and the actual code as primary sources
- Treat decisions from earlier steps (prior review results, planning decisions) as supplementary
- When information conflicts, prioritize `order.md` / `plan.md` / actual code
- When a user-facing specification changes, treat documentation and configuration examples as part of the contract and verify that every behavior listed in the requirements is present

### Referring to Design Decisions

- If the implementation step has emitted `coder-decisions.md`, read it and understand the recorded design decisions
- Do not dismiss intentional decisions as false positives just because they were recorded. Evaluate validity against `order.md` / `plan.md` / actual code
- If the design decision itself is flawed, raise it

### Full Entry Review for Contract Additions and Changes

When the diff adds or changes a contract such as a config value, state, condition expression, file format, event, builder, adapter, or state-transition function, enumerate and reconcile every entry, exit, and re-injection path that can carry that contract.

- Verify that definition, production, normalization, validation, evaluation, persistence, output, and event emission all apply the same contract
- Check derived paths as well as the normal entry: derived conditions, aggregate conditions, parent/child workflows, loop decisions, early exits, and exception paths
- When persisted data or externally supplied data is re-injected into JSON, Markdown, logs, events, or later instructions, include escaping, boundary handling, and failure behavior in the contract
- Verify that values normalized or validated at a boundary propagate as the same normalized value through persistence, execution, external calls, and event emission. Treat reuse of pre-normalized values in later stages as a contract inconsistency
- Search for existing returns, throws, catches, early returns, branches, and call sites with the same responsibility
- If an existing branch does not satisfy the new contract, treat it as related code even if the code itself predates the change
- If tests cover only the new path and do not verify existing equivalent branches or derived entries, treat it as a coverage gap
- Treating a required contract as optional, excluded, or a different requirement requires evidence from the task spec, specification, or explicit user instruction
- "Not explicitly stated in the task requirements" is not a valid reason to mark a contract inconsistency introduced by the diff as non-blocking

### Reviewing Side Effects and State Transitions

When a change involves side effects or state changes such as external calls, configuration application, sessions, queues, locks, subscriptions, caches, or temporary resources, do not judge from the happy path alone.

- Trace entry, normal completion, early return, exception, retry, interruption, and cleanup paths
- Verify that anything acquired, started, registered, or applied is handled exactly as required on the corresponding paths
- Verify that the same side effect is not executed more than once, and that required effects are not skipped on failure paths
- Verify that no new side effect, such as an external notification, confirmation request, tool call, or persistence write, is started after interruption, cancellation, timeout, or any other condition has made continuation invalid
- For changes that affect shared state or downstream execution, verify that partial failure does not leave state that breaks the next run
- If these checks have not been performed, do not treat the behavior as functionally verified

### Tracking Findings from Previous Reviews

**Precedence:**

1. If a parseable Finding Contract ledger / `findings-ledger.json` is available in a workflow configured with Finding Contract, use the ledger as the authoritative source for tracked findings. Fix only open findings from the ledger (`new`, `persists`, or `reopened`); ignore resolved or closed findings. Treat individual reports as supporting evidence reachable from the ledger.
2. If a ledger exists but is incomplete, follow mapped findings from the ledger and treat unmapped raw findings as potential new entries pending findings-manager reconciliation.
3. If the workflow is configured with Finding Contract but no parseable ledger is available, use the latest review reports in the Report Directory only as supporting evidence for observed raw findings. Do not assign final `finding_id` values or lifecycle states and do not apply the legacy rules; wait for ledger regeneration or findings-manager reconciliation.
4. If the workflow does not use `finding_contract` configuration, use the latest review reports in the Report Directory as the primary evidence and apply the legacy rules:
   - Look in the Report Directory for review reports this step has previously produced, along with their timestamped history
   - Treat the unsuffixed file as the latest result and the most recent `{report-name}.{timestamp}` as the previous result
   - `Previous Response` may be used as supplementary information, but finding state determinations must prioritize the report history
   - Do not drop open findings from the previous report when producing the new report
   - Apply the `finding_id` management rules when classifying each finding as `new` / `persists` / `resolved` / `reopened`
   - Mark `resolved` only when the original expected result and original requirement are satisfied, not merely because a patch exists

### Final Decision Steps

1. Classify each detected issue as blocking / non-blocking according to the scope rules and decision rules above
2. When citing test, build, or behavior verification as evidence, record the target, the check, and the result in the report
3. REJECT if there is at least one blocking issue (`new`, `persists`, or `reopened`)

## Detecting Circular Arguments

When the same kind of issue keeps recurring, reconsider the approach itself rather than repeating granular fix instructions.

If a finding is resolved and another finding with the same family appears at a different location in the next review, treat that as a failure to exhaust the family in the prior review, not as evidence that the unverified scope is shrinking.
