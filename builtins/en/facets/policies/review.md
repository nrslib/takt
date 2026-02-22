# Review Policy

Define the shared judgment criteria and behavioral principles for all reviewers.

## Principles

| Principle | Criteria |
|-----------|----------|
| Fix immediately | Never defer minor issues to "the next task." Fix now what can be fixed now |
| Eliminate ambiguity | Vague feedback like "clean this up a bit" is prohibited. Specify file, line, and proposed fix |
| Fact-check | Verify against actual code before raising issues. Do not speculate |
| Practical fixes | Propose implementable solutions, not theoretical ideals |
| Boy Scout | If a changed file has problems, have them fixed within the task scope |

## Scope Determination

| Situation | Verdict | Action |
|-----------|---------|--------|
| Problem introduced by this change | Blocking | REJECT |
| Code made unused by this change (arguments, imports, variables, functions) | Blocking | REJECT (change-induced problem) |
| Existing problem in a changed file | Blocking | REJECT (Boy Scout rule) |
| Structural problem in the changed module | Blocking | REJECT if within scope |
| Problem in an unchanged file | Non-blocking | Record only (informational) |
| Refactoring that greatly exceeds task scope | Non-blocking | Note as a suggestion |

## Judgment Criteria

### REJECT (Request Changes)

REJECT without exception if any of the following apply.

- New behavior without tests
- Bug fix without a regression test
- Use of `any` type
- Fallback value abuse (`?? 'unknown'`)
- Explanatory comments (What/How comments)
- Unused code ("just in case" code)
- Direct mutation of objects/arrays
- Swallowed errors (empty catch blocks)
- TODO comments (not tracked in an issue)
- Essentially identical logic duplicated (DRY violation)
- Method proliferation doing the same thing (should be absorbed by configuration differences)
- Specific implementation leaking into generic layers (imports and branching for specific implementations in generic layers)
- Internal implementation exported from public API (infrastructure functions or internal classes exposed publicly)
- Replaced code/exports surviving after refactoring
- Missing cross-validation of related fields (invariants of semantically coupled config values left unverified)

### Warning

Not blocking, but improvement is recommended.

- Insufficient edge case / boundary value tests
- Tests coupled to implementation details
- Overly complex functions/files
- Unclear naming
- Abandoned TODO/FIXME (those with issue numbers are acceptable)
- `@ts-ignore` or `eslint-disable` without justification

### APPROVE

Approve when all REJECT criteria are cleared and quality standards are met. Never give conditional approval. If there are problems, reject.

## Fact-Checking

Always verify facts before raising an issue.

| Do | Do Not |
|----|--------|
| Open the file and check actual code | Assume "it should be fixed already" |
| Search for call sites and usages with grep | Raise issues based on memory |
| Cross-reference type definitions and schemas | Guess that code is dead |
| Distinguish generated files (reports, etc.) from source | Review generated files as if they were source code |

## Writing Specific Feedback

Every issue raised must include the following.

- **Which file and line number**
- **What the problem is**
- **How to fix it**

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

## Boy Scout Rule

Leave it better than you found it.

### In Scope

- Existing problems in changed files (unused code, poor naming, broken abstractions)
- Structural problems in changed modules (mixed responsibilities, unnecessary dependencies)

### Out of Scope

- Unchanged files (record existing issues only)
- Refactoring that greatly exceeds task scope (note as a suggestion, non-blocking)

### Judgment

| Situation | Verdict |
|-----------|---------|
| Changed file has an obvious problem | REJECT — have it fixed together |
| Redundant expression (a shorter equivalent exists) | REJECT |
| Unnecessary branch/condition (unreachable or always the same result) | REJECT |
| Fixable in seconds to minutes | REJECT (do not mark as "non-blocking") |
| Code made unused as a result of the change (arguments, imports, etc.) | REJECT — change-induced, not an "existing problem" |
| Fix requires refactoring (large scope) | Record only (technical debt) |

Do not tolerate problems just because existing code does the same. If existing code is bad, improve it rather than match it.

## Judgment Rules

- All issues detected in changed files are blocking (REJECT targets), even if the code existed before the change
- Only issues in files NOT targeted by the change may be classified as "existing problems" or "non-blocking"
- "The code itself existed before" is not a valid reason for non-blocking. As long as it is in a changed file, the Boy Scout rule applies
- If even one issue exists, REJECT. "APPROVE with warnings" or "APPROVE with suggestions" is prohibited

## Detecting Circular Arguments

When the same kind of issue keeps recurring, reconsider the approach itself rather than repeating the same fix instructions.

### When the Same Problem Recurs

1. Check if the same kind of issue is being repeated
2. If so, propose an alternative approach instead of granular fix instructions
3. Even when rejecting, include the perspective of "a different approach should be considered"

Rather than repeating "fix this again," stop and suggest a different path.
