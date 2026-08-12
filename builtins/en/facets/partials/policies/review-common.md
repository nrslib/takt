# Review Policy

Define the shared judgment criteria and behavioral principles for all reviewers.

## Premise

This review is a defensive quality and security audit performed, on request, against a codebase provided as the review target. All reproduction and verification of vulnerabilities or defects is performed as self-tests within the target repository; applying techniques against third-party systems or developing attack tooling is not part of the purpose.

## Principles

| Principle | Criteria |
|-----------|----------|
| Fix immediately | Do not defer problems introduced by the change or causally required for the requirement or safety conditions |
| Eliminate ambiguity | Vague feedback like "clean this up a bit" is prohibited. Specify file, line, and proposed fix |
| Fact-check | Verify against actual code before raising issues. Do not speculate |
| Practical fixes | Propose implementable solutions, not theoretical ideals |
| State consistency | For side effects and state changes, verify real success, failure, and interruption paths for missing, duplicated, or inconsistent effects |
| Contract impact paths | Verify new contracts across input, transformation, persistence, and consumption paths confirmed from definitions and references |
| Contract consistency | Verify that contracts carried by consolidation or abstraction are applied to existing equivalent branches by the same standard |
| Semantic contract | For meaningful fields such as IDs, source, trace, and issue/PR numbers, verify not only the storage shape but also the meaning interpreted downstream |
| External contract verification | Verify semantic contracts of external services, SDKs, and generated artifacts from primary evidence or actual types |
| Specification completeness | When changing a user-facing contract, verify that implementation, tests, and documentation describe the same lookup order, override rules, special syntax, and failure conditions |
| Requirement anchoring | Do not reinterpret required task items as optional, out of scope, or different requirements for implementation convenience |
| Resolution judgment | Judge `resolved` against the original finding acceptance criteria and original task requirements, not merely against the presence of a fix |
| Defect-class re-scan | Before recognizing a defect as resolved, re-scan paths confirmed to have the same meaning, contract, and root cause against the original acceptance criteria |
| Concern handling | Judge only concerns related to the changed contract, and explain why any such concern is not a finding |
| Behavior evidence | Verify what behavior the tests or logs prove, not merely that they exist |
| Demonstrability | Distinguish items that environmental factors prevent demonstrating from implementation defects confirmed by current evidence |
| Boy Scout | Have existing problems fixed within task scope only when the change depends on, expands, or newly exposes them |

## Finding Decision Invariants

| Situation | Treatment |
|-----------|-----------|
| A current defect is verified in code or evidence and requires correction | Report it as an issue |
| Evidence is insufficient, the search scope is incomplete, or the result cannot be verified | Record it as unverified scope, not as an issue |
| Claiming absence or missing wiring | Report a locationless issue only when the original requirement or existing public contract makes existence or wiring necessary and every required route was searched |
| Questioning whether quality gates were run or their evidence was reported | Not an issue. Evaluating verification results is the final gate's jurisdiction |
| Environmental factors prevent demonstration, and neither current code nor reproducible evidence confirms a defect requiring correction | Record it as unverified scope; do not create an issue or REJECT |

- APPROVE means zero issues and REJECT means one or more issues. Never pad issues with approvals, summaries, or normal confirmations.

## Items That Cannot Be Demonstrated Due to Environmental Factors

Treat an item separately from an implementation defect only when all of the following conditions establish that environmental factors prevent its demonstration.

- The current execution environment does not provide a required OS, execution capability, external service, credential, or hardware resource
- Implementation, configuration, or test setup in the target repository cannot provide the missing environmental requirement
- Repeating work in the same execution environment cannot increase the evidence
- Every deterministic alternative verification available now and the execution path into the target environment have been verified

| Criteria | Judgment |
|----------|----------|
| Current code or reproducible evidence confirms an implementation defect | Apply the normal judgment criteria |
| All conditions above hold and no evidence indicates an implementation defect | Non-blocking. Record it as unverified scope |
| Repository configuration or test setup can provide the missing requirement | Do not classify it as environmentally undemonstrable; apply the normal judgment criteria |
| Demonstration in the target environment is itself an explicit requirement | Record it as a follow-up gate in an environment where it can run, not as implementation remediation |

## Scope Determination

| Situation | Verdict | Action |
|-----------|---------|--------|
| Problem introduced by this change | Blocking | REJECT |
| Code made unused by this change (arguments, imports, variables, functions) | Blocking | REJECT (change-induced problem) |
| Existing problem the change depends on, expands, or newly exposes | Blocking | REJECT (Boy Scout rule) |
| Existing ambiguous or incorrect contract exposed through a new public entry, adapter, or tool | Blocking | REJECT (existing behavior is not an exemption) |
| Structural problem directly affecting correctness of the change | Blocking | REJECT if within scope |
| Problem in an unchanged file | Non-blocking | Record only (informational) |
| Existing problem that merely shares a changed file but does not directly affect correctness of the change | Non-blocking | Record only (informational) |
| Refactoring that greatly exceeds task scope | Non-blocking | Note as a suggestion |

An existing problem is directly related only when the change depends on it, expands or newly exposes its impact, or cannot satisfy the current acceptance criteria or changed contract without fixing it. Proximity in the same file, function, hook, class, or call path is not sufficient. An existing problem is non-blocking when behavior and reachability remain unchanged from before the change and fixing it is unnecessary for the current requirement.

Encourage local Boy Scout improvements within that causal scope. Do not use the Boy Scout rule to expand task applicability or turn unrelated existing problems, performance improvements, design changes, or refactoring into blocking findings.

## Judgment Criteria

### REJECT (Request Changes)

First confirm causal scope under Scope Determination. Within that scope, REJECT if any of the following apply.

- New observable behavior whose regression existing tests cannot detect, without a test at the smallest contract-owning layer
- Boundary changes (permissions, rejection paths, external execution, shared state, state transitions) whose main allow/deny, success/failure, or isolation/release behavior cannot be verified at any layer, including existing evidence
- Bug fix without an existing or new regression test that would detect the pre-fix failure
- Use of `any` type
- Fallback value abuse (`?? 'unknown'`)
- Explanatory comments (What/How comments)
- Unused code ("just in case" code)
- Direct mutation of caller-owned, shared, or externally exposed objects/arrays
- Swallowed errors (empty catch blocks)
- TODO/FIXME without an issue number, external blocker, and removal condition
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

A finding must be directly supported by current code, types, schemas, primary specifications, or reproducible execution results. Memory, search mismatches, corrupted output, mocks that bypass the real path, and results where caching or skipping prevented target execution are not conclusive evidence. Claims that something is absent, unwired, or persists are not findings unless the governing contract and current implementation have been confirmed.

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

- Existing problems the change depends on, expands, or newly exposes (unused code, poor naming, broken abstractions)
- Structural problems directly affecting correctness of the change (mixed responsibilities, unnecessary dependencies)

### Out of Scope

- Unchanged files (record existing issues only)
- Existing problems that merely share a changed file but do not directly affect correctness, contracts, or wiring of the change
- Refactoring that greatly exceeds task scope (note as a suggestion, non-blocking)

### Judgment

| Situation | Verdict |
|-----------|---------|
| The change depends on, expands, or newly exposes an existing problem | REJECT — have it fixed together |
| Redundant expression or unnecessary branch introduced by the change | REJECT |
| Easy-to-fix issue with no causal relationship to the change | Out of scope. Ease of repair is not scope authority |
| Code made unused as a result of the change (arguments, imports, etc.) | REJECT — change-induced, not an "existing problem" |
| Fix requires refactoring (large scope) | Record only (technical debt) |

Within the causal scope, do not tolerate a problem merely because existing code does the same. Treat unrelated existing problems as separate work.

## Judgment Rules

- Existing problems the change depends on, expands, or newly exposes are blocking (REJECT targets), even if the code existed before the change
- Only issues not directly related to the change may be classified as "existing problems" or "non-blocking"
- Do not decide from "the code itself existed before" alone; verify the causal relationship to the change
- Do not make an existing problem blocking merely because it is in the same file, function, hook, class, or call path
- "Same as existing behavior" is not an approval reason when a new public entry, adapter, or tool exposes that contract
- When a concern mentioned in prose is not made a finding, classify it as `false_positive` / `overreach` / `out_of_scope` / `no_issue_after_verification` and provide evidence
- If even one issue exists, REJECT. "APPROVE with warnings" or "APPROVE with suggestions" is prohibited

## Detecting Circular Arguments

When the same kind of issue keeps recurring, reconsider the approach itself rather than repeating granular fix instructions.

If a finding is resolved and another finding with the same family appears at a different location in the next review, treat that as a failure to exhaust the family in the prior review, not as evidence that the unverified scope is shrinking.

{{include:policies/review-scope-authority}}
