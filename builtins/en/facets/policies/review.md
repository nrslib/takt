# Review Policy

Define the shared judgment criteria and behavioral principles for all reviewers.

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
| Specification completeness | When changing a user-facing contract, verify that implementation, tests, and documentation describe the same lookup order, override rules, special syntax, and failure conditions |
| Requirement anchoring | Do not reinterpret required task items as optional, out of scope, or different requirements for implementation convenience |
| Resolution judgment | Judge `resolved` against the original finding acceptance criteria and original task requirements, not merely against the presence of a fix |
| Behavior evidence | Verify what behavior the tests or logs prove, not merely that they exist |
| Boy Scout | Have problems fixed within the task scope when they are in changed code or in areas directly affecting correctness, contracts, or wiring of the change |

## Scope Determination

| Situation | Verdict | Action |
|-----------|---------|--------|
| Problem introduced by this change | Blocking | REJECT |
| Code made unused by this change (arguments, imports, variables, functions) | Blocking | REJECT (change-induced problem) |
| Existing problem in changed or directly related code | Blocking | REJECT (Boy Scout rule) |
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
- Direct mutation of objects/arrays
- Swallowed errors (empty catch blocks)
- TODO/FIXME without an issue number, external blocker, and removal condition
- Essentially identical logic duplicated (DRY violation)
- Method proliferation doing the same thing (should be absorbed by configuration differences)
- Specific implementation leaking into generic layers (imports and branching for specific implementations in generic layers)
- Internal implementation exported from public API (infrastructure functions or internal classes exposed publicly)
- Replaced code/exports surviving after refactoring
- Missing cross-validation of related fields (invariants of semantically coupled config values left unverified)
- Missing caller, producer, consumer, validator, test data, or derived-entry updates after a contract change
- User-facing contract changes for configuration, CLI, or file formats where documentation or examples omit priority, first-match/merge behavior, inline overrides, scoped/special references, or failure conditions
- Existing branches with the same contract remain on the old implementation after adding or changing a shared helper, normalizer, builder, or adapter
- Fields, attributes, outputs, settings, or identifiers requested by the task are treated as optional, unset, out of scope, or missing for some entry point or execution mode without explicit evidence
- Missing, duplicated, or incorrectly ordered effects in side-effect or state-change paths
- Sensitive data exposed in logs, error responses, or test output

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

## Writing Specific Feedback

Every issue raised must include the following.

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

- Every issue raised in a REJECT must include a `finding_id`
- If the same issue is raised again, reuse the same `finding_id`
- For repeated issues, set status to `persists` and include concrete evidence (file/line) that it remains unresolved
- New issues must use status `new`
- Resolved issues must be listed with status `resolved`
- Issues without `finding_id` are invalid (cannot be used as rejection grounds)
- REJECT is allowed only when there is at least one `new` or `persists` issue
- Before treating a prior finding as resolved, verify that the fix did not introduce a different structural or contract problem

## Reopen Conditions (`resolved` -> open)

Reopening a resolved finding requires reproducible evidence.

- To reopen a previously `resolved` finding, all of the following are required  
  1. Reproduction steps (command/input)  
  2. Expected result vs. actual result  
  3. Failing file/line evidence
- If any of the three is missing, the reopen attempt is invalid (cannot be used as REJECT grounds)
- If reproduction conditions changed, treat it as a different problem and issue a new `finding_id`

## Immutable Meaning of `finding_id`

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
- If even one issue exists, REJECT. "APPROVE with warnings" or "APPROVE with suggestions" is prohibited

## Basic Review Procedure

Common procedure that every reviewer must follow. Do not duplicate this in individual instructions.

### Diff Baseline (Anchor to the Base)

The review target is the entire cumulative diff from the task's starting point (the base), not just the changes from the most recent iteration.

- In the fix ↔ review loop, recompute the diff from the base every time and evaluate the whole. Do not move the baseline to the latest fix
- The base is the merge-base with the integration branch, or the starting point recorded in `plan` / `order`. Do not treat only the "changes" section of `Previous Response` as the diff
- Unrequested changes introduced in earlier iterations (unrelated comment deletions, renames, reformatting, contract changes, weakened tests) remain in the cumulative diff even when they no longer appear in the latest fix report. Reconcile against them every time
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
- For changes that affect shared state or downstream execution, verify that partial failure does not leave state that breaks the next run
- If these checks have not been performed, do not treat the behavior as functionally verified

### Tracking Findings from Previous Reviews

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
