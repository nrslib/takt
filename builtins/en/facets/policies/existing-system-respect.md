# Existing System Respect Policy

For released or operational systems, make only changes causally related to the request and preserve existing contracts outside the change scope. This policy limits the scope of changes and fixes; it does not limit investigation or finding reports by specialist reviewers.

## Principles

| Principle | Criteria |
|-----------|----------|
| Existing contracts first | Preserve contracts outside the requested change scope that existing users, tests, and operations depend on |
| Causal diff | Make only changes required by the request and changes needed to connect, verify, or keep them consistent |
| Necessity over proximity | Do not use the same file, nearby responsibility, or general style as justification for a change |
| Respect existing structure | Do not change file placement, type names, public APIs, or responsibility boundaries without a causal relationship to the request |
| Preserve observable contracts | Do not treat UI, accessibility, tests, logs, APIs, types, file placement, or comments recording intent, constraints, or calculation rationale as incidental |
| Primary evidence | Verify external-service, SDK, and generated-artifact contracts from official specifications or actual types and schemas |

## Separation of Investigation, Findings, and Remediation Authority

- Do not use this policy to limit a specialist reviewer's investigation scope or finding reports.
- Report causally related robustness, security, and correctness problems normally under the criteria of each specialist policy.
- Do not downgrade, suppress, or dismiss a finding that satisfies a specialist policy's criteria because of this policy.
- The `review-adjudication` policy is the source of truth for authority to remediate a finding in the current change. When this policy conflicts with an adjudication, follow `review-adjudication`.

## Change and Remediation Boundary

| Situation | Verdict |
|-----------|---------|
| Change required to satisfy the request | OK |
| Change needed to connect, verify, or keep a required change consistent | OK |
| Local fix needed to stop a side effect introduced by a required change | OK |
| Structural change causally related to the request or valid adjudication | OK. Record the reason and impact scope |
| Cleanup, rename, move, or public-contract change justified only by proximity to touched code | REJECT |
| Style improvement, refactoring, or test-expectation weakening without causal relationship to the request | REJECT |

Plan rationale alone does not authorize changing an existing contract. Such a change requires an explicit user request, an acceptance criterion, or remediation authority recognized by `review-adjudication`.

## Contract Checks

| Target | Criteria |
|--------|----------|
| UI copy, accessible names, role/state | Change only when causally related to an authorized requirement |
| Return structures, public type names, consumer interfaces, public function names | Make only consumer updates required by an authorized change |
| Test expectations | Change only for a requested specification change; do not weaken them for implementation convenience |
| Comments | Change only to correct an error or when removal of the relevant code makes them wholly obsolete |
| External dependency contracts | Do not generalize operation-specific errors, states, return values, idempotency, limits, or optionality without primary evidence |

## Pre-Completion Check

Classify the full diff using the following criteria and do not complete while an `unnecessary` change remains.

| Classification | Criteria |
|----------------|----------|
| `required` | The request cannot be satisfied without it |
| `related` | Needed to connect, verify, or keep a `required` change consistent |
| `unnecessary` | Lacks causal relationship to the request and is justified only by readability, style, incidental cleanup, or future extensibility |
